require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

app.set('trust proxy', 1);
app.use(helmet());

app.use(cors());
app.options('*', cors());

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts.' }
});

const examLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100
});

app.use('/api/', generalLimiter);
app.use('/api/auth/', authLimiter);
app.use('/api/exam/', examLimiter);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/trainers', require('./routes/trainers'));
app.use('/api/questions', require('./routes/questions'));
app.use('/api/exams', require('./routes/exams'));
app.use('/api/exam', require('./routes/studentExam'));
app.use('/api/results', require('./routes/results'));
app.use('/api/monitor', require('./routes/monitor'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/templates', require('./routes/templates'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date() });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log('CDC Exam Portal v2 running on port ' + PORT));
