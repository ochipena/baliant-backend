require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const nodemailer = require('nodemailer');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// La llave maestra para crear los pases VIP (tokens) de sesión
const JWT_SECRET = process.env.JWT_SECRET || 'super_secreto_baliant_123';

const app = express();
app.use(cors());
app.use(express.json());

const clienteMP = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

// 🔥 NUEVA CONEXIÓN A NEON (LA NUBE)
const pool = new Pool({
    connectionString: "postgresql://neondb_owner:npg_sHyFU3Jq9WrV@ep-nameless-dream-acd29zo6-pooler.sa-east-1.aws.neon.tech/neondb?sslmode=require",
    ssl: {
        rejectUnauthorized: false // Esto es clave para que los servidores confíen en la conexión
    }
});


app.get('/', (req, res) => {
    res.send('¡El servidor de BALIANT está funcionando!');
});

app.get('/productos', async (req, res) => {
    try {
        const resultado = await pool.query('SELECT * FROM productos');
        res.json(resultado.rows);
    } catch (error) {
        console.error(error.message);
        res.status(500).send('Hubo un error al buscar la ropa');
    }
});

// --- RUTA: BUSCAR UN SOLO PRODUCTO POR ID ---
app.get('/productos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const resultado = await pool.query('SELECT * FROM productos WHERE id = $1', [id]);
        
        if (resultado.rows.length === 0) {
            return res.status(404).json({ error: 'Prenda no encontrada' });
        }
        
        res.json(resultado.rows[0]);
    } catch (error) {
        console.error(error.message);
        res.status(500).send('Hubo un error al buscar la prenda');
    }
});

// --- RUTA PROTEGIDA: PANEL DE ADMINISTRADOR BALIANT ---
app.get('/api/ventas', async (req, res) => {
    const claveSecreta = req.headers['admin-pass'];

    if (claveSecreta !== process.env.PASSWORD_ADMIN) {
        return res.status(401).json({ error: 'Acceso denegado. Contraseña incorrecta.' });
    }

    try {
        const resultado = await pool.query('SELECT * FROM ventas ORDER BY id_pago DESC');
        res.json(resultado.rows);
    } catch (error) {
        console.error("Error al buscar las ventas:", error.message);
        res.status(500).json({ error: 'Hubo un error al obtener las ventas' });
    }
});

// --- RUTA: CREAR PREFERENCIA Y GESTIONAR USUARIO EN CHECKOUT ---
app.post('/crear-preferencia', async (req, res) => {
    try {
        // 🔥 AHORA ATRAPAMOS EL DESCUENTO DESDE EL FRONTEND
        const { items, comprador, porcentajeDescuento } = req.body;
        let idUsuarioParaVenta = null;
        
        // Si no mandaron ningún cupón, el descuento es 0
        const descuentoApp = porcentajeDescuento || 0; 

        // 1. VERIFICAR SI EL USUARIO YA EXISTE EN LA BASE DE DATOS
        const usuarioExistente = await pool.query('SELECT id FROM usuarios WHERE email = $1', [comprador.email]);

        if (usuarioExistente.rows.length > 0) {
            // Si ya existe, guardamos su ID
            idUsuarioParaVenta = usuarioExistente.rows[0].id;
        } 
        // 2. MAGIA: Si no existe Y tildó la opción de crear cuenta en el checkout
        else if (comprador.crearCuenta === true && comprador.password) {
            const saltRounds = 10;
            const passwordHash = await bcrypt.hash(comprador.password, saltRounds);

            const nuevoUsuario = await pool.query(`
                INSERT INTO usuarios (nombre, email, telefono, provincia, direccion, codigo_postal, password_hash, fecha_registro) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP) RETURNING id
            `, [
                comprador.nombre, 
                comprador.email, 
                comprador.telefono,
                comprador.provincia,
                comprador.direccion,
                comprador.cp,
                passwordHash
            ]);

            idUsuarioParaVenta = nuevoUsuario.rows[0].id;
            console.log("👤 ¡Nuevo usuario creado exitosamente desde el checkout! ID:", idUsuarioParaVenta);
        }

        // ==========================================
        // 3. LÓGICA DE MERCADO PAGO (CON CUPONES)
        // ==========================================
        
        // Formateamos los items para MP y le ESCONDEMOS el ID y el talle
        const itemsMP = items.map(item => {
            // Si es el costo de envío, no tiene talle ni se le aplica descuento
            if (item.nombre === "Costo de Envío") {
                return {
                    title: item.nombre,
                    unit_price: Number(item.precio),
                    quantity: Number(item.cantidad),
                    currency_id: 'ARS'
                };
            }

            // 🔥 MAGIA MATEMÁTICA: Le restamos el descuento a la ropa y REDONDEAMOS
            const precioOriginal = Number(item.precio);
            const precioConDescuento = Math.round(precioOriginal - ((precioOriginal * descuentoApp) / 100));

            // Si es una remera, le escondemos la data clave y cambiamos el título
            return {
                id: item.id.toString(), 
                title: descuentoApp > 0 ? `${item.nombre} (${descuentoApp}% OFF)` : item.nombre,
                description: item.talle || "Único", 
                unit_price: precioConDescuento, // Acaba de viajar redondeado
                quantity: Number(item.cantidad),
                currency_id: 'ARS'
            };
        });

        // ARMAMOS EL PAQUETE CON MUCHO CUIDADO DE LAS LLAVES
        const body = {
            items: itemsMP,
            payer: {
                name: comprador.nombre,
                email: comprador.email
            },
            metadata: {
                nombre_cliente: comprador.nombre,
                email_cliente: comprador.email,
                telefono_cliente: comprador.telefono,
                provincia: comprador.provincia,
                direccion: comprador.direccion,
                codigo_postal: comprador.cp,
                usuario_id: idUsuarioParaVenta 
            }, // <-- OJO ACÁ: La coma que cierra la metadata

            // LAS URLs OFICIALES DE TU NUEVA CASA (Vercel)
            back_urls: {
                success: "https://baliant-frontend.vercel.app/exito.html", 
                failure: "https://baliant-frontend.vercel.app/index.html",
                pending: "https://baliant-frontend.vercel.app/index.html"
            },
            
            // 🔥 ¡AHORA SÍ! Como Vercel es una web real, activamos el piloto automático
            auto_return: "approved", 
            
            // EL NUEVO RADAR DEL CARTERO (Chau Ngrok, hola Render)
            notification_url: "https://baliant-backend.onrender.com/webhook"
        };

        // 🔥 EL RADAR: Esto va a imprimir en tu consola negra exactamente lo que le mandás a MP
        console.log("📦 PAQUETE QUE VA A MERCADO PAGO:");
        console.log(JSON.stringify(body, null, 2));

        const preference = new Preference(clienteMP);
        const response = await preference.create({ body });

        res.json({ linkPago: response.init_point });

    } catch (error) {
        console.error("❌ Error en el servidor al procesar el pago:", error);
        res.status(500).json({ error: "Hubo un error al procesar el pago y guardar los datos." });
    }
});

// --- EL TELÉFONO ROJO: WEBHOOK ---
app.post('/webhook', async (req, res) => {
    console.log("\n🔔 [Paso 1] ¡ALGUIEN TOCÓ LA PUERTA DEL WEBHOOK!");
    
    // Le respondemos rápido a MP para que no mande 500 avisos iguales
    res.status(200).send("OK");

    try {
        const tipoNotificacion = req.query.topic || req.body.type;
        const idNotificacion = req.query.id || req.body.data?.id;

        if (tipoNotificacion === "payment" || tipoNotificacion === "payment.created") {
            const clientPayment = new Payment(clienteMP);
            const infoPago = await clientPayment.get({ id: idNotificacion });

            if (infoPago.status === 'approved') {
                const idVenta = infoPago.id;
                console.log(`🔍 [Paso 2] Analizando pago aprobado #${idVenta}...`);
                
                // --- EL VERDADERO FILTRO DE DUPLICADOS ---
                const ventaExistente = await pool.query('SELECT id FROM ventas WHERE id_pago = $1', [idVenta]);
                
                if (ventaExistente.rows.length > 0) {
                    console.log(`♻️ [Freno] La venta #${idVenta} ya estaba guardada. Ignorando duplicado real.`);
                    return; // ⛔ ACÁ CORTA LA EJECUCIÓN SI ES DUPLICADO. Si no, sigue de largo.
                }

                console.log(`✅ [Paso 3] Es una venta NUEVA. Intentando guardar en Base de Datos...`);
                const totalVenta = infoPago.transaction_amount;
                const emailCliente = infoPago.metadata.email_cliente || infoPago.payer.email; 
                const nombreCliente = infoPago.metadata.nombre_cliente;
                const telefonoCliente = infoPago.metadata.telefono_cliente;
                const idUsuario = infoPago.metadata.usuario_id || null; 
                const provincia = infoPago.metadata.provincia;
                const direccion = infoPago.metadata.direccion;
                const cp = infoPago.metadata.codigo_postal;
                const carritoVendido = infoPago.additional_info && infoPago.additional_info.items 
                    ? JSON.stringify(infoPago.additional_info.items) 
                    : '[]';

                // ==========================================
                // 💾 1. GUARDADO EN BASE DE DATOS
                // ==========================================
                try {
                    await pool.query(
                        `INSERT INTO ventas (id_pago, total, estado, nombre_cliente, provincia, direccion, codigo_postal, email, telefono, usuario_id, productos_vendidos) 
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                        [idVenta, totalVenta, infoPago.status, nombreCliente, provincia, direccion, cp, emailCliente, telefonoCliente, idUsuario, carritoVendido]
                    );
                    console.log("💰 ¡VENTA EXITOSA EN BALIANT! (Guardada en DB)");
                } catch (errorDB) {
                    // SI SALTA ESTE ERROR, ES UN PROBLEMA DE SQL, NO UN DUPLICADO
                    console.error("❌ [ERROR GRAVE EN BASE DE DATOS]:", errorDB.message);
                    return; // Cortamos porque si no hay venta, no hay mails ni stock
                }

                // ==========================================
                // ✉️ 2. ENVÍO DE CORREOS (VÍA API GOOGLE)
                // ==========================================
                console.log("👉 [Paso 4] Intentando enviar correos vía API de Google...");
                try {
                    const apiGoogle = "https://script.google.com/macros/s/AKfycbztDLJRE1RQju9SYZCOVvYuDgtkRa5DSAg6toHhiIUmwnyzQ_vzw078HA1Nj5epzw9Z/exec";

                    // 1. Disparamos el mail para el cliente
                    await fetch(apiGoogle, {
                        method: 'POST',
                        body: JSON.stringify({
                            to: emailCliente,
                            subject: "¡Gracias por tu compra en BALIANT! 👕",
                            html: `
                                <h2>¡Hola! Tu pago se acreditó con éxito.</h2>
                                <p>Gracias por confiar en BALIANT. Acá tenés el resumen de tu pedido:</p>
                                <ul>
                                    <li><b>Número de Orden:</b> #${idVenta}</li>
                                    <li><b>Total pagado:</b> $${totalVenta}</li>
                                </ul>
                                <p>En breve nos pondremos en contacto para coordinar la entrega.</p>
                                <p>Saludos,<br><b>El equipo de BALIANT</b></p>
                            `
                        })
                    });

                    // 2. Disparamos tu mail de aviso (Dueño)
                    await fetch(apiGoogle, {
                        method: 'POST',
                        body: JSON.stringify({
                            to: process.env.EMAIL_BALIANT,
                            subject: `💰 ¡NUEVA VENTA! - Orden #${idVenta}`,
                            html: `
                                <h2>¡Felicidades, entró una nueva venta!</h2>
                                <p><b>Cliente:</b> ${emailCliente}</p>
                                <p><b>Total:</b> $${totalVenta}</p>
                                <p>Entrá a tu base de datos para ver más detalles.</p>
                            `
                        })
                    });

                    console.log("✉️ [ÉXITO] ¡Los dos correos saltaron el bloqueo de Render y fueron enviados!");
                } catch (errorMail) {
                    console.error("❌ [ERROR EN CORREOS API]:", errorMail.message);
                }

                // ==========================================
                // 📉 3. DESCUENTO DE STOCK AUTOMÁTICO
                // ==========================================
                console.log("👉 [Paso 5] Intentando descontar stock...");
                if (infoPago.additional_info && infoPago.additional_info.items) {
                    for (let item of infoPago.additional_info.items) {
                        const idProd = item.id;
                        const talleVendido = item.description; 
                        const cantVendida = Number(item.quantity);

                        if (idProd && talleVendido) {
                            try {
                                const resProd = await pool.query('SELECT variantes FROM productos WHERE id = $1', [idProd]);
                                if (resProd.rows.length > 0) {
                                    let variantesArray = resProd.rows[0].variantes;
                                    if (typeof variantesArray === 'string') variantesArray = JSON.parse(variantesArray);

                                    const indiceTalle = variantesArray.findIndex(v => v.talle === talleVendido);
                                    if (indiceTalle !== -1) {
                                        variantesArray[indiceTalle].stock -= cantVendida;
                                        if (variantesArray[indiceTalle].stock < 0) variantesArray[indiceTalle].stock = 0; 
                                        
                                        await pool.query('UPDATE productos SET variantes = $1 WHERE id = $2', [JSON.stringify(variantesArray), idProd]);
                                        console.log(`📉 [ÉXITO] Se restaron ${cantVendida} unid. del talle ${talleVendido} (Prenda #${idProd})`);
                                    }
                                }
                            } catch (errorStock) {
                                console.error(`❌ [ERROR EN STOCK - Prenda #${idProd}]:`, errorStock.message);
                            }
                        }
                    }
                }
            }
        }
    } catch (errorGeneral) {
        console.error("❌ [ERROR FATAL DEL WEBHOOK]:", errorGeneral.message);
    }
});

// ==================================================
// 🔐 SISTEMA DE USUARIOS BALIANT
// ==================================================

app.post('/registro', async (req, res) => {
    try {
        const { nombre, email, password, direccion, telefono, provincia, cp } = req.body;

        const usuarioExistente = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
        if (usuarioExistente.rows.length > 0) {
            return res.status(400).json({ error: 'Este email ya tiene una cuenta en BALIANT.' });
        }

        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);

        const nuevoUsuario = await pool.query(
            `INSERT INTO usuarios (nombre, email, password_hash, direccion, telefono, provincia, codigo_postal, fecha_registro) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP) RETURNING id, nombre, email`,
            [nombre, email, passwordHash, direccion, telefono, provincia, cp]
        );

        res.status(201).json({ mensaje: '¡Cuenta creada con éxito!', usuario: nuevoUsuario.rows[0] });
    } catch (error) {
        console.error("Error en el registro:", error);
        res.status(500).json({ error: 'Hubo un problema al crear la cuenta.' });
    }
});

app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        const resultado = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
        if (resultado.rows.length === 0) {
            return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
        }

        const usuario = resultado.rows[0];

        const passwordValida = await bcrypt.compare(password, usuario.password_hash);
        if (!passwordValida) {
            return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
        }

        const token = jwt.sign(
            { id: usuario.id, email: usuario.email }, 
            JWT_SECRET, 
            { expiresIn: '30d' }
        );

        res.json({
            mensaje: '¡Bienvenido de nuevo a BALIANT!',
            token: token,
            usuario: {
                id: usuario.id,
                nombre: usuario.nombre,
                email: usuario.email,
                telefono: usuario.telefono,
                provincia: usuario.provincia,
                direccion: usuario.direccion,
                codigo_postal: usuario.codigo_postal
            }
        });
    } catch (error) {
        console.error("Error en el login:", error);
        res.status(500).json({ error: 'Hubo un problema al iniciar sesión.' });
    }
});

// ==================================================
// 📝 MIDDLEWARE Y RUTA DE PERFIL E HISTORIAL
// ==================================================

// Guardia de Seguridad
const verificarToken = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(403).json({ error: "No enviaste un token de seguridad." });

    try {
        const tokenLimpio = token.split(" ")[1] || token;
        const decodificado = jwt.verify(tokenLimpio, JWT_SECRET);
        req.usuarioId = decodificado.id;
        next();
    } catch (error) {
        return res.status(401).json({ error: "Token inválido o vencido. Volvé a iniciar sesión." });
    }
};

// Ruta para extraer historial
app.get('/perfil', verificarToken, async (req, res) => {
    try {
        const datosUsuario = await pool.query(`
            SELECT id, nombre, email, telefono, provincia, direccion, codigo_postal 
            FROM usuarios WHERE id = $1
        `, [req.usuarioId]);

        if (datosUsuario.rows.length === 0) {
            return res.status(404).json({ error: "Usuario no encontrado." });
        }

        const historialVentas = await pool.query(`
            SELECT id_pago AS orden, total, estado, fecha AS fecha_compra
            FROM ventas WHERE usuario_id = $1 ORDER BY id_pago DESC
        `, [req.usuarioId]);

        res.json({
            perfil: datosUsuario.rows[0],
            historial: historialVentas.rows
        });
    } catch (error) {
        console.error("❌ Error al cargar perfil:", error);
        res.status(500).json({ error: "Error en el servidor al cargar tu historial." });
    }
});

// --- RUTA: CONTACTO WHATSAPP ---
app.get('/contacto', (req, res) => {
    res.json({ telefono: process.env.NUMERO_WHATSAPP });
});

// ==========================================
// 🛡️ RUTAS DEL PANEL DE ADMINISTRADOR
// ==========================================

// 1. Mostrar todas las ventas (con contraseña secreta)
app.get('/api/ventas', async (req, res) => {
    // 🔥 CAMBIÁ ESTA CONTRASEÑA POR LA TUYA DE ADMIN
    const pass = req.headers['admin-pass'];
    if (pass !== 'baliantadmin123') { 
        return res.status(401).json({ error: "No autorizado" });
    }

    try {
        // Pedimos TODO a la base de datos, incluyendo la columna nueva "productos_vendidos"
        const result = await pool.query(`
            SELECT id_pago, nombre_cliente, telefono, direccion, provincia, codigo_postal, total, estado, productos_vendidos
            FROM ventas 
            ORDER BY fecha_compra DESC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error("Error al traer ventas:", error);
        res.status(500).json({ error: "Error interno" });
    }
});

// ==========================================
// 2. Botón de "Marcar como Enviado" y MANDAR MAIL
// ==========================================
app.put('/api/ventas/:id/enviar', async (req, res) => {
    // 🔥 Acordate de usar tu contraseña real acá si la cambiaste
    const pass = req.headers['admin-pass'];
    if (pass !== 'BaliantAdmin2026') { 
        return res.status(401).json({ error: "No autorizado" });
    }

    const idPago = req.params.id;
    
    try {
        // 1. Buscamos los datos de la venta ANTES de actualizar para sacar el email
        const ventaInfo = await pool.query('SELECT email, nombre_cliente, total FROM ventas WHERE id_pago = $1', [idPago]);
        
        if (ventaInfo.rows.length === 0) {
            return res.status(404).json({ error: "Venta no encontrada en la BD" });
        }

        const datosVenta = ventaInfo.rows[0];

        // 2. Cambiamos el estado de 'approved' a 'enviado' en PostgreSQL
        await pool.query('UPDATE ventas SET estado = $1 WHERE id_pago = $2', ['enviado', idPago]);

        // 3. ARMAMOS Y MANDAMOS EL MAIL DE DESPACHO AL CLIENTE
        const mailDespacho = {
            from: `"BALIANT" <${process.env.EMAIL_BALIANT}>`,
            to: datosVenta.email, // Se lo mandamos al email que quedó guardado en la venta
            subject: "🚚 ¡Tu pedido está en camino! - BALIANT",
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #00e5ff; border-radius: 10px; background-color: #050505; color: #fff;">
                    <h2 style="color: #00e5ff; text-transform: uppercase; text-align: center;">¡Tu piel está en camino!</h2>
                    <p>Hola <b>${datosVenta.nombre_cliente}</b>,</p>
                    <p>Te escribimos para avisarte que tu pedido <b>#${idPago}</b> acaba de ser <b>DESPACHADO</b> y ya está en manos del correo.</p>
                    <div style="background: #111; padding: 15px; border-radius: 5px; text-align: center; margin: 20px 0; border: 1px solid #333;">
                        <span style="font-size: 1.2rem; color: #128C7E; font-weight: bold;">✔ En viaje</span>
                    </div>
                    <p style="color: #aaa;">En breve vas a estar recibiendo tus prendas BALIANT en tu domicilio.</p>
                    <p style="text-align: center; color: #666; margin-top: 30px; font-size: 0.8rem;">
                        ¡Gracias por jugar en serio!<br><b>El equipo de BALIANT</b>
                    </p>
                </div>
            `
        };

        // Disparamos el correo
        await transporter.sendMail(mailDespacho);
        console.log(`🚚 Pedido #${idPago} despachado. Correo enviado a ${datosVenta.email}`);

        // 4. Le avisamos al panel de admin que salió todo perfecto
        res.json({ mensaje: "Estado actualizado y correo enviado con éxito" });

    } catch (error) {
        // Si hay un error, ahora la terminal te va a chismosear exactamente qué falló
        console.error("❌ Error grave al intentar despachar el pedido:", error);
        res.status(500).json({ error: "Error interno en el servidor" });
    }
});

// 🔥 EL PUERTO DINÁMICO PARA LA NUBE
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🚀 Servidor de BALIANT volando en el puerto ${PORT}`);
});