const https = require('https');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const path = require('path');
const { logoData } = require('./logo.js');

const app = express();

// ========================================
// 🔹 Cargar variables del .env manualmente
// ========================================
function loadEnv(filePath = '.env') {
  const envPath = path.resolve(__dirname, filePath);
  if (fs.existsSync(envPath)) {
    const envFile = fs.readFileSync(envPath, 'utf8');
    envFile.split('\n').forEach(line => {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim().replace(/^['"]|['"]$/g, ""); // quita comillas
        process.env[key] = value;
      }
    });
  }
}
loadEnv();

// Puerto
const PORT = process.env.PORT || 3000;

// 🔥 Configuración dinámica de CORS según el entorno
const corsOptions = {
  origin: function (origin, callback) {
    if (process.env.NODE_ENV === 'development') {
      // En desarrollo permitir todos los orígenes
      callback(null, true);
    } else if (process.env.NODE_ENV === 'production') {
      const allowedOrigin = process.env.ALLOWED_ORIGIN;
      if (!origin) return callback(null, true); // llamadas sin origen (ej: servidor)
      if (allowedOrigin && origin === allowedOrigin) {
        callback(null, true);
      } else {
        callback(new Error('Origen no permitido por CORS'));
      }
    } else {
      callback(null, true); // por defecto
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Auth']
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.static('public'));

// Manejo de errores CORS
app.use((err, req, res, next) => {
  if (err.message === 'Origen no permitido por CORS') {
    return res.status(403).json({ error: 'Origen no permitido' });
  }
  next(err);
});

// ========================================
// 🔹 Función para generar comandos ESC/POS
// ========================================
function generatePrintCommand(content, boleto) {
  function appendBytes(arr1, arr2) {
    const merged = new Uint8Array(arr1.length + arr2.length);
    merged.set(arr1);
    merged.set(arr2, arr1.length);
    return merged;
  }

  function stringToEscPos(content, boleto) {
    const encoder = new TextEncoder();
    let escPos = new Uint8Array(0);

    function feedAndCut() {
      let seq = new Uint8Array(0);
      seq = appendBytes(seq, encoder.encode('\n\n\n\n'));
      seq = appendBytes(seq, new Uint8Array([0x1D, 0x56, 0x00]));
      return seq;
    }

    escPos = appendBytes(escPos, new Uint8Array([0x1B, 0x40]));

    if (content && boleto) {
      escPos = appendBytes(escPos, new Uint8Array([0x1B, 0x61, 0x00]));
      escPos = appendBytes(escPos, encoder.encode(content));
      escPos = appendBytes(escPos, feedAndCut());

      escPos = appendBytes(escPos, new Uint8Array([0x1B, 0x61, 0x01]));
      escPos = appendBytes(escPos, logoData);
      escPos = appendBytes(escPos, encoder.encode('\n\n'));
      escPos = appendBytes(escPos, new Uint8Array([0x1B, 0x61, 0x00]));
      escPos = appendBytes(escPos, encoder.encode(boleto));
      escPos = appendBytes(escPos, feedAndCut());
    } else if (boleto) {
      const firstLine = boleto.split('\n')[0] || '---------';
      escPos = appendBytes(escPos, new Uint8Array([0x1B, 0x40]));
      escPos = appendBytes(escPos, new Uint8Array([0x1B, 0x61, 0x01]));
      escPos = appendBytes(escPos, encoder.encode(firstLine + '\n'));
      escPos = appendBytes(escPos, feedAndCut());

      escPos = appendBytes(escPos, new Uint8Array([0x1B, 0x40]));
      escPos = appendBytes(escPos, new Uint8Array([0x1B, 0x61, 0x01]));
      escPos = appendBytes(escPos, logoData);
      escPos = appendBytes(escPos, new Uint8Array([0x0A, 0x0A]));
      escPos = appendBytes(escPos, new Uint8Array([0x1B, 0x61, 0x00]));
      escPos = appendBytes(escPos, encoder.encode(boleto));
      escPos = appendBytes(escPos, feedAndCut());
    } else if (content) {
      escPos = appendBytes(escPos, new Uint8Array([0x1B, 0x61, 0x00]));
      escPos = appendBytes(escPos, encoder.encode(content));
      escPos = appendBytes(escPos, feedAndCut());
    }

    return escPos;
  }

  function uint8ToBase64(uint8arr) {
    let binary = '';
    for (let i = 0; i < uint8arr.length; i++) {
      binary += String.fromCharCode(uint8arr[i]);
    }
    return Buffer.from(binary, 'binary').toString('base64');
  }

  const escPosData = stringToEscPos(content, boleto);
  return uint8ToBase64(escPosData);
}

// ========================================
// 🔹 Rutas
// ========================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Ruta protegida para obtener credenciales
app.get('/get_credentials', (req, res) => {
  const authHeader = req.headers['x-api-auth'];
  if (authHeader !== process.env.INTERNAL_AUTH_TOKEN) {
    return res.status(403).json({ error: 'Acceso no autorizado' });
  }
  res.json({
    email: process.env.FRONT_EMAIL,
    password: process.env.FRONT_PASSWORD
  });
});

// Obtener IP y ubicación
app.get('/get_ip', (req, res) => {
  res.json({
    ip: process.env.AMOS_IP,
    ubicacion: process.env.AMOS_LOCATION
  });
});

app.post('/print', (req, res) => {
  const { content, boleto } = req.body;
  if (!content && !boleto) {
    return res.status(400).json({ error: 'No hay datos proporcionados' });
  }
  try {
    const base64 = generatePrintCommand(content, boleto);
    res.json({ rawbt: `rawbt:base64,${base64}` });
  } catch (err) {
    console.error('Error generating ESC/POS from text:', err);
    res.status(500).json({ error: 'Failed to convert text to print command' });
  }
});

// ========================================
// 🔹 Servidor HTTPS
// ========================================
const sslOptions = {
  key: fs.readFileSync('./key.pem'),
  cert: fs.readFileSync('./cert.pem'),
};

https.createServer(sslOptions, app).listen(PORT, () => {
  console.log(` \~E API escuchando en puerto ${PORT}`);
  console.log(`Entorno: ${process.env.NODE_ENV || 'development'}`);
  console.log(`CORS: ${process.env.NODE_ENV === 'production' ? 'Origen restringido' : 'Todos los orígenes'}`);
});