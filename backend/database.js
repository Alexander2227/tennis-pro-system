/* ==================================
   ARCHIVO: backend/database.js
   ESTRUCTURA DE DATOS MAESTRA
   ================================== */

const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

// Conexión a la base de datos (se crea el archivo si no existe)
const db = new sqlite3.Database('./tennispro.db', (err) => {
  if (err) {
    return console.error(err.message);
  }
  console.log('✅ Conectado a la base de datos SQLite (tennispro.db).');
});

db.serialize(() => {
  
  // 1. Tabla Clientes
  db.run(`CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    apellido TEXT NOT NULL,
    celular TEXT NOT NULL,
    fechaNacimiento TEXT NOT NULL,
    nacionalidad TEXT NOT NULL,
    dui TEXT UNIQUE,
    pasaporte TEXT UNIQUE
  )`);

  // 2. Tabla Profesores (Usuarios del Sistema)
  db.run(`CREATE TABLE IF NOT EXISTS profesores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    rol TEXT NOT NULL DEFAULT 'profesor'
  )`, (err) => {
      if (!err) {
          // Crear Admin por defecto (admin@tennis.pro / 12345)
          bcrypt.hash("12345", 10, (err, hash) => {
              db.run("INSERT OR IGNORE INTO profesores (nombre, email, password_hash, rol) VALUES (?, ?, ?, ?)", 
              ["Administrador", "admin@tennis.pro", hash, "admin"]);
          });
          
          // Crear Profesor por defecto (profe@tennis.pro / 12345)
          bcrypt.hash("12345", 10, (err, hash) => {
              db.run("INSERT OR IGNORE INTO profesores (nombre, email, password_hash, rol) VALUES (?, ?, ?, ?)", 
              ["Profesor Uno", "profe@tennis.pro", hash, "profesor"]);
          });
      }
  });

  // 3. Tabla Reservas
  db.run(`CREATE TABLE IF NOT EXISTS reservas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fechaReserva TEXT NOT NULL,
    horaReserva TEXT NOT NULL,
    keyUnica TEXT NOT NULL UNIQUE,
    estado TEXT DEFAULT 'pendiente',
    tipo_reserva TEXT NOT NULL,
    cliente_id INTEGER NOT NULL,
    profesor_id INTEGER,
    hora_llegada TEXT,
    FOREIGN KEY(cliente_id) REFERENCES clientes(id),
    FOREIGN KEY(profesor_id) REFERENCES profesores(id)
  )`);

});

module.exports = db;