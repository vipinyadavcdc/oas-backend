require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const app = express();
app.set('trust proxy', 1);
app.use(helmet());
// ── CORS — must be before rate limiters so OPTIONS preflight is never blocked ─
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true); // server-to-server / health checks
    const allowed =
      origin.endsWith('.vercel.app') ||
      origin.startsWith('http://localhost') ||
      origin.startsWith('http://127.0.0.1');
    if (allowed) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
// ─────────────────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
const generalLimiter = rateLimit({ windowMs: 15*60*1000, max: 200, message: { error: 'Too many requests.' } });
const authLimiter    = rateLimit({ windowMs: 15*60*1000, max: 200,  message: { error: 'Too many login attempts.' } });
const examLimiter    = rateLimit({ windowMs: 60*1000,    max: 100 });
app.use('/api/', generalLimiter);
app.use('/api/auth/', authLimiter);
app.use('/api/exam/', examLimiter);
app.use('/api/auth',         require('./routes/auth'));
app.use('/api/trainers',     require('./routes/trainers'));
app.use('/api/questions',    require('./routes/questions'));
app.use('/api/exams',        require('./routes/exams'));
app.use('/api/exam',         require('./routes/studentExam'));
app.use('/api/results',      require('./routes/results'));
app.use('/api/monitor',      require('./routes/monitor'));
app.use('/api/audit',        require('./routes/audit'));
app.use('/api/templates',    require('./routes/templates'));
app.use('/api/analysis',     require('./routes/analysis'));
app.use('/api/psychometric', require('./routes/psychometric'));
app.use('/api/departments',  require('./routes/departments'));
app.use('/api/sessions',     require('./routes/sessions'));
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log('CDC Exam Portal v2 running on port ' + PORT));
