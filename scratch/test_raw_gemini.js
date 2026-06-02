const key = 'AIzaSyB2t8vCiM3ad6uIzJCjpLgejrsyO4IU08A';
const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;
fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] })
}).then(res => res.json().then(data => {
    console.log('STATUS:', res.status);
    console.log('BODY:', JSON.stringify(data, null, 2));
    process.exit(0);
})).catch(err => {
    console.error(err);
    process.exit(1);
});
