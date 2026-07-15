const { exec } = require('child_process');

exec('tasklist /FO CSV /NH', (err, stdout) => {
  if (err) {
    console.error('Tasklist failed:', err);
    process.exit(1);
  }
  const processes = stdout.split('\n')
    .map(line => line.split(',')[0])
    .map(name => name.replace(/"/g, '').trim().toLowerCase())
    .filter(name => name.length > 0);
    
  console.log('Tasklist succeeded! Found ' + processes.length + ' processes.');
  console.log('Sample processes:', processes.slice(0, 5));
});
