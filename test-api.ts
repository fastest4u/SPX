// Native fetch is available in Node 18+

async function runTests() {
  const API = 'http://localhost:3000/api';
  console.log('--- Starting API Tests ---');

  // 1. Login
  const loginRes = await fetch(`${API}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  if (!loginRes.ok) throw new Error('Login failed');
  const rawCookie = loginRes.headers.get('set-cookie') || '';
  console.log('Raw cookie:', rawCookie);
  const tokenCookie = rawCookie.split(';')[0];
  console.log('Token cookie:', tokenCookie);
  const baseHeaders = { 'Cookie': tokenCookie };
  const jsonHeaders = { ...baseHeaders, 'Content-Type': 'application/json' };

  // 2. Create User
  const username = 'testuser_' + Date.now();
  const createRes = await fetch(`${API}/users`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ username, password: 'password123' })
  });
  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error('Create user failed: ' + text);
  }
  console.log('✅ Create user successful');

  // 3. Get Users
  const usersRes = await fetch(`${API}/users`, { headers: baseHeaders });
  const users = await usersRes.json();
  const testUser = users.find((u: any) => u.username === username);
  if (!testUser) throw new Error('Test user not found in list');
  console.log(`✅ Get users successful (Found testuser1 with id ${testUser.id})`);

  // 4. Change Password
  const changePwdRes = await fetch(`${API}/users/${testUser.id}/password`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ password: 'newpassword123' })
  });
  if (!changePwdRes.ok) throw new Error('Change password failed');
  console.log('✅ Change password successful');

  // 5. Audit Logs
  const auditRes = await fetch(`${API}/audit-logs`, { headers: baseHeaders });
  const logs = await auditRes.json();
  if (logs.length < 3) throw new Error('Audit logs missing');
  console.log('✅ Audit logs retrieved successful (Count: ' + logs.length + ')');
  console.log('   Latest log: ' + logs[0].action + ' - ' + logs[0].details);

  // 6. Delete User
  const deleteRes = await fetch(`${API}/users/${testUser.id}`, { method: 'DELETE', headers: baseHeaders });
  if (!deleteRes.ok) {
    const text = await deleteRes.text();
    throw new Error('Delete user failed: ' + text);
  }
  console.log('✅ Delete user successful');

  // 7. Logout
  const logoutRes = await fetch(`${API}/logout`, { method: 'POST', headers: baseHeaders });
  if (!logoutRes.ok) throw new Error('Logout failed');
  console.log('✅ Logout successful');

  console.log('--- All Tests Passed Successfully ---');
}

runTests().catch(e => {
  console.error('❌ Test failed:', e.message);
  process.exit(1);
});
