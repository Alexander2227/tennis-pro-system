/* ==================================
   ARCHIVO: backend/server.js
   ¡CORRECCIÓN: BLOQUEO DE HORAS PASADAS!
   ================================== */

const express = require('express');
const cors = require('cors');
const db = require('./database.js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = 3000;
const JWT_SECRET = "clave_secreta_tennis_pro";
const MAX_CUPOS_CANCHA = 2;
const MAX_CUPOS_INSTRUCTOR = 2;
const MINUTOS_DE_GRACIA = 15;

app.use(cors());
app.use(express.json());

// --- MIDDLEWARE ---
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: "No autorizado" });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: "Token inválido" });
    req.profesor = user; next();
  });
}

// --- HELPER: Parsear Hora AM/PM a 24h ---
function parseHora(horaStr) {
    // Entrada: "3:00 PM" o "03:00 PM" -> Salida: 15
    const [time, modifier] = horaStr.split(' ');
    let [hours, minutes] = time.split(':');
    if (hours === '12') hours = '00';
    if (modifier === 'PM') hours = parseInt(hours, 10) + 12;
    return parseInt(hours, 10);
}

// --- API RESERVAS (CON CANDADO DE TIEMPO) ---
app.post('/api/reservas', (req, res) => {
  const { nombre, apellido, celular, fechaNacimiento, nacionalidad, dui, pasaporte, tipoReserva, fechaReserva, horaReserva } = req.body;
  
  // 1. VALIDACIÓN DE TIEMPO CRÍTICA
  const ahora = new Date();
  // Crear fecha de la reserva (Asumiendo YYYY-MM-DD)
  const [y, m, d] = fechaReserva.split('-').map(Number);
  const horaNum = parseHora(horaReserva); // Convertir "3:00 PM" a 15
  
  // Crear objeto fecha para la reserva
  const fechaCita = new Date(y, m - 1, d, horaNum, 0, 0);

  // Si la fecha de la cita es MENOR a ahora (con 5 min de margen por reloj lento), error.
  if (fechaCita < new Date(ahora.getTime() - 5 * 60000)) {
      return res.status(400).json({ message: "⚠️ No puedes reservar una hora que ya pasó." });
  }

  db.serialize(() => {
    db.run(`INSERT INTO clientes (nombre, apellido, celular, fechaNacimiento, nacionalidad, dui, pasaporte) VALUES (?,?,?,?,?,?,?)`, 
    [nombre, apellido, celular, fechaNacimiento, nacionalidad, dui||null, pasaporte||null], function(err) {
        const cid = this.lastID || 1;
        
        const sql_check = `SELECT tipo_reserva, COUNT(*) as c FROM reservas WHERE fechaReserva = ? AND horaReserva = ? AND estado IN ('pendiente', 'confirmada', 'confirmada_tarde') GROUP BY tipo_reserva`;
        db.all(sql_check, [fechaReserva, horaReserva], (err, rows) => {
            let cc = 0, ci = 0;
            if(rows) rows.forEach(r => { cc += r.c; if(r.tipo_reserva === 'con_instructor') ci += r.c; });
            
            if (cc >= MAX_CUPOS_CANCHA) return res.status(400).json({message: "Horario lleno."});
            if (tipoReserva === 'con_instructor' && ci >= MAX_CUPOS_INSTRUCTOR) return res.status(400).json({message: "Instructor ocupado."});

            const keyUnica = Math.random().toString(36).substring(2, 8).toUpperCase();
            db.run(`INSERT INTO reservas (fechaReserva, horaReserva, keyUnica, cliente_id, tipo_reserva) VALUES (?,?,?,?,?)`, 
                [fechaReserva, horaReserva, keyUnica, cid, tipoReserva], (err) => {
                if(err) return res.status(500).json({message: "Error al guardar."});
                res.status(201).json({message: `¡Reserva confirmada!`, keyUnica: keyUnica});
            });
        });
    });
  });
});

// --- RESTO DE APIS (Mantener igual) ---
app.get('/api/profesor/metrics', authenticateToken, (req, res) => {
    // Clases hoy
    db.get(
        `SELECT COUNT(*) as c FROM reservas WHERE estado LIKE 'confirmada%' AND DATE(hora_llegada)=DATE('now','localtime')`,
        [],
        (err, h) => {
            // Clases semana
            db.get(
                `SELECT COUNT(*) as c FROM reservas WHERE estado LIKE 'confirmada%' AND DATE(hora_llegada)>=DATE('now','localtime','-7 days')`,
                [],
                (err, s) => {
                    // Canchas semana
                    db.get(
                        `SELECT COUNT(*) as c FROM reservas WHERE estado LIKE 'confirmada%' AND tipo_reserva='cancha' AND DATE(hora_llegada)>=DATE('now','localtime','-7 days')`,
                        [],
                        (err, cs) => {
                            res.json({
                                clasesHoy: h?.c ?? 0,
                                clasesSemana: s?.c ?? 0,
                                canchasSemana: cs?.c ?? 0
                            });
                        }
                    );
                }
            );
        }
    );
});

app.post('/api/reservas/cancelar', (req, res) => {
    const { keyUnica } = req.body;
    db.get("SELECT id FROM reservas WHERE keyUnica = ? AND estado = 'pendiente'", [keyUnica], (err, row) => {
        if(!row) return res.status(404).json({message: "No encontrada."});
        db.run("UPDATE reservas SET estado = 'cancelada' WHERE id = ?", [row.id], (err) => { res.json({message: "Reserva cancelada exitosamente."}); });
    });
});

app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  db.get("SELECT * FROM profesores WHERE email = ?", [email], (err, user) => {
    if(!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({message: "Credenciales inválidas"});
    const token = jwt.sign({ id: user.id, nombre: user.nombre, rol: user.rol }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, profesor: { id: user.id, nombre: user.nombre, rol: user.rol } });
  });
});

app.post('/api/profesor/validar-asistencia', authenticateToken, (req, res) => {
    const { keyUnica } = req.body;
    const pid = req.profesor.id;
    db.get("SELECT * FROM reservas WHERE keyUnica=? AND (estado='pendiente' OR estado='ausente')", [keyUnica], (err, r) => {
        if(!r) return res.status(404).json({message: "Código no válido."});
        let nuevo = r.estado==='ausente' ? 'confirmada_tarde' : 'confirmada';
        db.run("UPDATE reservas SET estado=?, profesor_id=?, hora_llegada=CURRENT_TIMESTAMP WHERE id=?", [nuevo, pid, r.id], ()=>{
            res.json({message: `¡Asistencia ${nuevo.toUpperCase()} registrada!`});
        });
    });
});

// ... (Resto de APIs: metrics, pending-classes, analytics, actividad, historial, pdf, usuarios) ...
// (Asegúrate de mantener las que ya tenías abajo de esto)
app.get('/api/profesor/metrics', authenticateToken, (req, res) => {
    db.get(`SELECT COUNT(*) as c FROM reservas WHERE estado LIKE 'confirmada%' AND DATE(hora_llegada)=DATE('now','localtime')`, [], (err, h) => {
        db.get(`SELECT COUNT(*) as c FROM reservas WHERE estado LIKE 'confirmada%' AND DATE(hora_llegada)>=DATE('now','localtime','-7 days')`, [], (err, s) => res.json({clasesHoy:h?.c||0, clasesSemana:s?.c||0}));
    });
});
app.get('/api/profesor/pending-classes', authenticateToken, (req, res) => {
    // Limpieza automatica
    db.run(`UPDATE reservas SET estado='ausente' WHERE estado='pendiente' AND DATETIME(fechaReserva || ' ' || horaReserva, '+${MINUTOS_DE_GRACIA} minutes') < DATETIME('now', 'localtime')`, [], ()=>{
        db.all(`SELECT r.fechaReserva, r.horaReserva, c.nombre as nombreCliente, c.apellido as apellidoCliente, r.tipo_reserva FROM reservas r JOIN clientes c ON r.cliente_id=c.id WHERE r.estado='pendiente' ORDER BY r.fechaReserva, r.horaReserva LIMIT 20`, [], (err, rows) => res.json(rows||[]));
    });
});
app.get('/api/admin/analytics', authenticateToken, (req, res) => {
    // ... (Analytics igual que la versión v6.5)
    const { rango, tipo, estado } = req.query; let filter="1=1", group="fechaReserva";
    if(rango==='hoy') { filter="DATE(fechaReserva)=DATE('now','localtime')"; group="horaReserva"; }
    else if(rango==='mes') filter="fechaReserva>=DATE('now','localtime','-30 days')";
    else filter="fechaReserva>=DATE('now','localtime','-7 days')";
    let sql = `SELECT ${group} as etiqueta, COUNT(*) as total, SUM(CASE WHEN estado='confirmada' THEN 1 ELSE 0 END) as ok, SUM(CASE WHEN estado='confirmada_tarde' THEN 1 ELSE 0 END) as tarde, SUM(CASE WHEN estado='ausente' THEN 1 ELSE 0 END) as ausente, SUM(CASE WHEN estado='pendiente' THEN 1 ELSE 0 END) as pendiente, SUM(CASE WHEN tipo_reserva='con_instructor' THEN 1 ELSE 0 END) as instructor FROM reservas WHERE ${filter} AND estado!='cancelada'`;
    if(tipo && tipo!=='todos') sql+=` AND tipo_reserva='${tipo}'`;
    if(estado && estado!=='todos') sql+=` AND estado='${estado}'`;
    sql += ` GROUP BY ${group} ORDER BY ${group}`;
    db.all(sql, [], (err, rows) => {
        let tR=0, tOk=0, tTarde=0, tAus=0, tPen=0, tInst=0;
        if(rows) rows.forEach(r=>{ tR+=r.total; tOk+=r.ok; tTarde+=r.tarde; tAus+=r.ausente; tPen+=r.pendiente; tInst+=r.instructor; });
        res.json({ timeline: rows || [], totales: {reservas: tR, ok: tOk, tarde: tTarde, ausencias: tAus, pendientes: tPen, instructor: tInst} });
    });
});
app.get('/api/admin/actividad', authenticateToken, (req, res) => {
    db.all(`SELECT r.id, r.keyUnica, r.estado, r.hora_llegada, r.fechaReserva, r.horaReserva, r.tipo_reserva, c.nombre, c.apellido FROM reservas r JOIN clientes c ON r.cliente_id=c.id ORDER BY r.id DESC LIMIT 10`, [], (err, rows) => res.json(rows||[]));
});
app.get('/api/admin/historial', authenticateToken, (req, res) => {
    const { busqueda, inicio, fin } = req.query;
    let sql = `SELECT r.*, c.* FROM reservas r JOIN clientes c ON r.cliente_id = c.id WHERE 1=1`;
    let params = [];
    if (busqueda) { sql += ` AND (c.nombre LIKE ? OR r.keyUnica LIKE ?)`; params.push(`%${busqueda}%`, `%${busqueda}%`); }
    if (inicio) { sql += ` AND r.fechaReserva >= ?`; params.push(inicio); }
    if (fin) { sql += ` AND r.fechaReserva <= ?`; params.push(fin); }
    sql += ` ORDER BY r.fechaReserva DESC LIMIT 100`;
    db.all(sql, params, (err, rows) => {
        const hoy = new Date();
        const data = rows.map(r => {
            const [y,m,d] = r.fechaNacimiento.split('-').map(Number);
            let edad = hoy.getFullYear() - y;
            if(hoy.getMonth() < m-1 || (hoy.getMonth()===m-1 && hoy.getDate()<d)) edad--;
            return {...r, edad};
        });
        res.json(data);
    });
});
app.get('/api/admin/profesores', authenticateToken, (req, res) => { db.all("SELECT id, nombre, email, rol FROM profesores", [], (err, rows) => res.json(rows)); });
app.post('/api/admin/profesores', authenticateToken, (req, res) => { bcrypt.hash(req.body.password, 10, (err,h)=> db.run("INSERT INTO profesores (nombre, email, password_hash, rol) VALUES (?,?,?,?)", [req.body.nombre, req.body.email, h, req.body.rol], ()=>res.json({message:"OK"}))); });
app.delete('/api/admin/profesores/:id', authenticateToken, (req, res) => { db.run("DELETE FROM profesores WHERE id=?", [req.params.id], ()=>res.json({message:"OK"})); });
app.get('/api/admin/reporte-pdf', authenticateToken, (req, res) => {
    const doc = new PDFDocument({margin: 50});
    const { fechaInicio, fechaFin } = req.query;
    res.setHeader('Content-disposition', 'attachment; filename="Reporte.pdf"'); doc.pipe(res);
    let sql = `SELECT r.*, c.nombre, c.apellido FROM reservas r JOIN clientes c ON r.cliente_id=c.id WHERE 1=1`;
    let params = [];
    if(fechaInicio) { sql += " AND r.fechaReserva >= ?"; params.push(fechaInicio); }
    if(fechaFin) { sql += " AND r.fechaReserva <= ?"; params.push(fechaFin); }
    sql += " ORDER BY r.fechaReserva, r.horaReserva";
    db.all(sql, params, (err, rows) => {
        doc.fontSize(20).text("REPORTE", {align:'center'}); doc.moveDown();
        rows.forEach(r => doc.fontSize(10).text(`${r.fechaReserva} ${r.horaReserva} - ${r.nombre} [${r.estado}]`)); doc.end();
    });
});

app.listen(PORT, () => console.log(`Servidor listo en http://localhost:${PORT}`));