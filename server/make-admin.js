// Usage: node make-admin.js <email-or-username>
// Promotes a user to admin so they can access /admin.html and the admin API routes.
const db = require('./db');

const query = process.argv[2];
if (!query) {
  console.log('Usage: node make-admin.js <email-or-username>');
  process.exit(1);
}

const user = db.prepare('SELECT * FROM users WHERE email = ? OR username = ?').get(query, query);
if (!user) {
  console.log('No user found matching:', query);
  process.exit(1);
}

db.prepare('UPDATE users SET is_admin = 1, updated_at = ? WHERE id = ?').run(Date.now(), user.id);
console.log(`✔ ${user.username} (${user.email || user.id}) is now an admin.`);
