// Run this ONCE on Railway to fix admin passwords:
// node db/seed.js
require('dotenv').config()
const pool = require('./pool')
const bcrypt = require('bcryptjs')

async function seed() {
  const admins = [
    { emp_id: 'EMP001', name: 'Vipin',   email: 'vipin@mrei.ac.in',   role: 'super_admin' },
    { emp_id: 'EMP002', name: 'Ankur',   email: 'ankur@mrei.ac.in',   role: 'super_admin' },
    { emp_id: 'EMP003', name: 'Kirti',   email: 'kirti@mrei.ac.in',   role: 'super_admin' },
    { emp_id: 'EMP004', name: 'Harmeet', email: 'harmeet@mrei.ac.in', role: 'super_admin' },
  ]

  for (const admin of admins) {
    const hash = await bcrypt.hash(admin.emp_id, 12)
    await pool.query(
      `INSERT INTO trainers (emp_id, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (emp_id) DO UPDATE SET password_hash = $4, role = $5, is_active = true`,
      [admin.emp_id, admin.name, admin.email, hash, admin.role]
    )
    console.log(`✅ Seeded: ${admin.emp_id} (${admin.name})`)
  }

  console.log('\n✅ All admins seeded. Default password = emp_id (e.g. EMP001)')
  process.exit(0)
}

seed().catch(err => { console.error('Seed failed:', err); process.exit(1) })
