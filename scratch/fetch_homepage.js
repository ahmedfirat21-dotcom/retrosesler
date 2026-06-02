const https = require('https');

https.get('https://retrosesler.com/', (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
        console.log("Status:", res.statusCode);
        console.log("Headers:", res.headers);
        const containsGuide = data.includes('myrooms-guide-box');
        console.log("Contains myrooms-guide-box:", containsGuide);
        
        // Print surrounding lines if found
        if (containsGuide) {
            const idx = data.indexOf('myrooms-guide-box');
            console.log("Snippet:", data.substring(idx - 100, idx + 400));
        } else {
            console.log("Guide box NOT found in live homepage!");
            console.log("Length of page received:", data.length);
        }
    });
}).on('error', (err) => {
    console.error("Error fetching homepage:", err);
});
