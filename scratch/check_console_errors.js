const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TARGET_URL = 'http://localhost:3000/';

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            res.setEncoding('utf8');
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

async function main() {
    console.log('Starting headless Chrome...');
    const chrome = spawn(CHROME_PATH, [
        '--headless',
        '--remote-debugging-port=9222',
        '--disable-gpu',
        '--window-size=1400,900'
    ]);
    
    await sleep(2000);
    
    let wsUrl = '';
    try {
        const list = await getJson('http://localhost:9222/json/list');
        const page = list.find(t => t.type === 'page');
        wsUrl = page.webSocketDebuggerUrl;
    } catch (e) {
        console.error('Failed to get Chrome debugging WebSocket URL:', e.message);
        chrome.kill();
        process.exit(1);
    }
    
    const ws = new WebSocket(wsUrl);
    ws.on('open', async () => {
        console.log('Connected to Chrome debug socket');
        try {
            // Enable domains to listen to console log and exceptions
            const id1 = Math.floor(Math.random() * 1000000);
            ws.send(JSON.stringify({ id: id1, method: 'Runtime.enable' }));
            
            const id2 = Math.floor(Math.random() * 1000000);
            ws.send(JSON.stringify({ id: id2, method: 'Log.enable' }));
            
            ws.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.method === 'Runtime.consoleAPICalled') {
                    const args = msg.params.args.map(a => a.value || a.description || JSON.stringify(a)).join(' ');
                    console.log(`[Browser Console - ${msg.params.type}]:`, args);
                }
                if (msg.method === 'Runtime.exceptionThrown') {
                    console.error('[Browser Exception]:', msg.params.exceptionDetails.text, msg.params.exceptionDetails.exception.description);
                }
                if (msg.method === 'Log.entryAdded') {
                    console.log('[Browser Log Entry]:', msg.params.entry.text, `(${msg.params.entry.level})`);
                }
            });
            
            console.log('Navigating to:', TARGET_URL);
            const idNav = Math.floor(Math.random() * 1000000);
            ws.send(JSON.stringify({ id: idNav, method: 'Page.navigate', params: { url: TARGET_URL } }));
            
            await sleep(6000); // listen to console events for 6 seconds
            console.log('Finished listening.');
        } catch (err) {
            console.error('Error during execution:', err);
        } finally {
            ws.close();
            chrome.kill();
            process.exit(0);
        }
    });
}

main();
