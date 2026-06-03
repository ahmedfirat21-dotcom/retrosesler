const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const HOST = 'http://localhost:3000';
const OUT_DIR = path.join(__dirname); // C:\Users\yogun\retrosesler-v2\scratch

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

function sendCDP(ws, method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1000000);
        const msg = JSON.stringify({ id, method, params });
        
        const listener = (data) => {
            const res = JSON.parse(data.toString());
            if (res.id === id) {
                ws.removeListener('message', listener);
                if (res.error) reject(res.error);
                else resolve(res.result);
            }
        };
        
        ws.on('message', listener);
        ws.send(msg);
    });
}

async function captureUrl(ws, url, width, height, filename) {
    console.log(`Navigating to ${url} with size ${width}x${height}...`);
    await sendCDP(ws, 'Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width < 600,
    });
    await sendCDP(ws, 'Page.navigate', { url });
    await sleep(4000); // Wait for loading
    
    const { data } = await sendCDP(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const filePath = path.join(OUT_DIR, filename);
    fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
    console.log(`Saved screenshot: ${filePath}`);
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
        console.error('Failed to get WebSocket debugger URL:', e.message);
        chrome.kill();
        process.exit(1);
    }
    
    const ws = new WebSocket(wsUrl);
    ws.on('open', async () => {
        try {
            await sendCDP(ws, 'Page.enable');
            await sendCDP(ws, 'Runtime.enable');
            await sendCDP(ws, 'DOM.enable');
            
            console.log('Navigating to home page to login as guest...');
            await sendCDP(ws, 'Emulation.setDeviceMetricsOverride', {
                width: 1400,
                height: 900,
                deviceScaleFactor: 1,
                mobile: false,
            });
            await sendCDP(ws, 'Page.navigate', { url: `${HOST}/` });
            await sleep(3500);
            
            console.log('Calling lobbyGuest() to authenticate...');
            await sendCDP(ws, 'Runtime.evaluate', {
                expression: `lobbyGuest();`
            });
            await sleep(2000); // wait for login + page reload
            
            // Now we are logged in! Capture the screens.
            
            // 1. Logged in Lobby Desktop
            await captureUrl(ws, `${HOST}/`, 1400, 900, 'screenshot_lobby_auth_desktop.png');
            
            // 2. Logged in Lobby Mobile
            await captureUrl(ws, `${HOST}/`, 375, 812, 'screenshot_lobby_auth_mobile.png');
            
            // 3. Logged in Room Desktop
            await captureUrl(ws, `${HOST}/oda`, 1400, 900, 'screenshot_room_auth_desktop.png');
            
            // 4. Logged in Room Mobile
            await captureUrl(ws, `${HOST}/oda`, 375, 812, 'screenshot_room_auth_mobile.png');
            
            console.log('All authenticated screenshots captured!');
        } catch (err) {
            console.error('Error during automation:', err);
        } finally {
            ws.close();
            chrome.kill();
            process.exit(0);
        }
    });
}

main();
