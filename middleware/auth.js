const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

// Verify JWT token
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer '))
      return res.status(401).json({ error: 'No token provided' });

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const result = await pool.query(
      'SELECT id, emp_id, name, email, role, designation, mobile, is_active FROM trainers WHERE id = $1',
      [decoded.id]
    );
    if (!result.rows.length || !result.rows[0].is_active)
      return res.status(401).json({ error: 'Invalid or inactive account' });

    req.trainer = result.rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Role hierarchy helpers
const isMasterAdmin = (trainer) => trainer.role === 'master_admin';
const isSuperAdmin  = (trainer) => trainer.role === 'super_admin' || trainer.role === 'master_admin';
const isTrainer     = (trainer) => ['trainer', 'super_admin', 'master_admin'].includes(trainer.role);

// Middleware: master_admin only
const requireMasterAdmin = (req, res, next) => {
  if (!isMasterAdmin(req.trainer))
    return res.status(403).json({ error: 'Master admin access required' });
  next();
};

// Middleware: super_admin or master_admin
const requireSuperAdmin = (req, res, next) => {
  if (!isSuperAdmin(req.trainer))
    return res.status(403).json({ error: 'Super admin access required' });
  next();
};

// Middleware: question write access (super_admin or master_admin)
const requireQuestionAccess = (req, res, next) => {
  if (!isSuperAdmin(req.trainer))
    return res.status(403).json({ error: 'Only super admin and master admin can manage questions' });
  next();
};

// Audit log helper
const auditLog = async (trainerId, action, entityType, entityId, details, ip) => {
  try {
    await pool.query(
      `INSERT INTO audit_logs (trainer_id, action, entity_type, entity_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [trainerId, action, entityType, entityId, JSON.stringify(details), ip]
    );
  } catch (e) {
    console.error('Audit log error:', e);
  }
};

module.exports = {
  authenticate,
  requireMasterAdmin,
  requireSuperAdmin,
  requireQuestionAccess,
  isMasterAdmin,
  isSuperAdmin,
  isTrainer,
  auditLog
};
