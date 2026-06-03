const https = require('https');

const url = 'https://i.giphy.com/1400TDe9t4u2lO.gif';

const req = https.get(url, (res) => {
  console.log('Status Code:', res.statusCode);
  console.log('Headers:', res.headers);
  
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => {
    const buffer = Buffer.concat(chunks);
    console.log('Body length:', buffer.length);
    if (res.statusCode !== 200) {
      console.log('Body text:', buffer.toString('utf8').substring(0, 500));
    }
  });
});

req.on('error', (e) => {
  console.error('Request Error:', e);
});
