const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

(async () => {
    console.log("Starting Puppeteer test...");
    const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    
    let browser;
    try {
        browser = await puppeteer.launch({
            executablePath: chromePath,
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
    } catch (e) {
        console.error("Failed to launch Chrome:", e.message);
        process.exit(1);
    }
    
    console.log("Chrome launched. Creating page...");
    const page = await browser.newPage();
    
    // Set viewport to mobile (iPhone 12/13 Pro width/height)
    await page.setViewport({
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true
    });
    
    console.log("Navigating to retrosesler.com...");
    try {
        await page.goto('https://retrosesler.com', { waitUntil: 'networkidle2', timeout: 30000 });
    } catch (e) {
        console.warn("Navigation warning (timed out or network idle issue):", e.message);
    }
    
    console.log("Waiting for rooms grid to render...");
    try {
        await page.waitForSelector('.room', { timeout: 10000 });
    } catch (e) {
        console.error("Failed to find .room element:", e.message);
    }
    
    // Print computed styles of first room elements
    const styles = await page.evaluate(() => {
        const firstRoom = document.querySelector('.room');
        if (!firstRoom) return { error: "No room element found" };
        
        const desc = firstRoom.querySelector('.room-desc');
        const marquee = firstRoom.querySelector('.room-desc-marquee');
        const info = firstRoom.querySelector('.room-info');
        
        const getStyles = (el) => {
            if (!el) return null;
            const cs = window.getComputedStyle(el);
            return {
                tagName: el.tagName,
                className: el.className,
                display: cs.display,
                position: cs.position,
                transform: cs.transform,
                animationName: cs.animationName,
                animationPlayState: cs.animationPlayState,
                width: cs.width,
                height: cs.height,
                overflow: cs.overflow,
                textOverflow: cs.textOverflow,
                whiteSpace: cs.whiteSpace,
                textAlign: cs.textAlign,
                direction: cs.direction,
                marginLeft: cs.marginLeft,
                paddingLeft: cs.paddingLeft,
                textIndent: cs.textIndent
            };
        };
        
        return {
            roomText: firstRoom.innerText,
            info: getStyles(info),
            desc: getStyles(desc),
            marquee: getStyles(marquee)
        };
    });
    
    console.log("COMPUTED STYLES:", JSON.stringify(styles, null, 2));
    
    // Take screenshot of the rooms area or page
    const screenshotPath = path.join("C:\\Users\\yogun\\.gemini\\antigravity\\brain\\3ce20101-1f8d-464b-98b0-a0e0a2d4e3ff", "mobile_screenshot.png");
    console.log("Taking screenshot and saving to:", screenshotPath);
    
    await page.screenshot({ path: screenshotPath });
    console.log("Screenshot saved.");
    
    await browser.close();
    console.log("Browser closed.");
})();
