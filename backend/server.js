import path from 'path';
import express from 'express';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
dotenv.config();
import connectDB from './config/db.js';
import productRoutes from './routes/productRoutes.js';
import userRoutes from './routes/userRoutes.js';
import orderRoutes from './routes/orderRoutes.js';
import uploadRoutes from './routes/uploadRoutes.js';
import { notFound, errorHandler } from './middleware/errorMiddleware.js';

const port = process.env.PORT || 5000;
const REPLICA = process.env.CONTAINER_APP_REPLICA_NAME || 'local';

connectDB();

const app = express();

// La app corre detrás del ingress (proxy inverso) de Azure Container Apps
app.set('trust proxy', 1);

// Cabeceras de seguridad HTTP. La CSP se deja desactivada porque el SDK de
// PayPal y las imágenes de Blob Storage requieren una política a medida
// (pendiente como mejora).
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Identifica qué réplica respondió (útil para evidenciar el balanceo de carga)
app.use((req, res, next) => {
  res.setHeader('X-Replica', REPLICA);
  next();
});

// Sonda de salud usada por Container Apps (liveness/readiness)
app.get('/api/health', (req, res) => {
  const dbUp = mongoose.connection.readyState === 1;
  res.status(dbUp ? 200 : 503).json({
    status: dbUp ? 'ok' : 'degraded',
    replica: REPLICA,
    uptime: Math.round(process.uptime()),
  });
});

// Limita intentos de login/registro: mitiga fuerza bruta
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Demasiados intentos, intente más tarde' },
});
app.use('/api/users/auth', authLimiter);
app.post('/api/users', authLimiter);

app.use('/api/products', productRoutes);
app.use('/api/users', userRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/upload', uploadRoutes);

app.get('/api/config/paypal', (req, res) =>
  res.send({ clientId: process.env.PAYPAL_CLIENT_ID })
);

const __dirname = path.resolve();
app.use('/uploads', express.static(path.join(__dirname, '/uploads')));

if (process.env.NODE_ENV === 'production') {
  app.use(
    express.static(path.join(__dirname, '/frontend/build'), { maxAge: '7d' })
  );
  app.get('*', (req, res) =>
    res.sendFile(path.resolve(__dirname, 'frontend', 'build', 'index.html'))
  );
} else {
  app.get('/', (req, res) => {
    res.send('API is running....');
  });
}

app.use(notFound);
app.use(errorHandler);

const server = app.listen(port, () =>
  console.log(
    `Server running in ${process.env.NODE_ENV} mode on port ${port} (replica ${REPLICA})`
  )
);

// Apagado ordenado: cuando la plataforma reduce réplicas envía SIGTERM.
// Se terminan las peticiones en curso antes de cerrar.
const shutdown = (signal) => {
  console.log(`${signal} recibido, cerrando réplica ${REPLICA}...`);
  server.close(async () => {
    await mongoose.connection.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
