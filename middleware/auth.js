const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

// Verify JWT token
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const result = await pool.query(
      'SELECT id, emp_id, name, email, role, is_active FROM trainers WHERE id = $1',
      [decoded.id]
    );
    if (!result.rows.length || !result.rows[0].is_active) {
      return res.status(401).json({ error: 'Invalid or inactive account' });
    }
    req.trainer = result.rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Only super_admin can access
const requireSuperAdmin = (req, res, next) => {
  if (req.trainer.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
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

module.exports = { authenticate, requireSuperAdmin, auditLog };
