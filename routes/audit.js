const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authenticate, requireSuperAdmin } = require('../middleware/auth');

// GET /api/audit — get audit logs (super admin only)
router.get('/', authenticate, requireSuperAdmin, async (req, res) => {
  const { trainer_id, action, entity_type, from_date, to_date, page = 1, limit = 100 } = req.query;
  const conditions = [];
  const params = [];
  let i = 1;

  if (trainer_id) { conditions.push(`al.trainer_id=$${i++}`); params.push(trainer_id); }
  if (action) { conditions.push(`al.action ILIKE $${i++}`); params.push(`%${action}%`); }
  if (entity_type) { conditions.push(`al.entity_type=$${i++}`); params.push(entity_type); }
  if (from_date) { conditions.push(`al.created_at >= $${i++}`); params.push(from_date); }
  if (to_date) { conditions.push(`al.created_at <= $${i++}`); params.push(to_date); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const offset = (page - 1) * limit;
  params.push(limit, offset);

  try {
    const result = await pool.query(
      `SELECT al.*, t.name as trainer_name, t.emp_id FROM audit_logs al
       LEFT JOIN trainers t ON al.trainer_id = t.id
       ${where} ORDER BY al.created_at DESC LIMIT $${i} OFFSET $${i+1}`,
      params
    );
    const count = await pool.query(`SELECT COUNT(*) FROM audit_logs al ${where}`, params.slice(0, -2));
    res.json({ logs: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
