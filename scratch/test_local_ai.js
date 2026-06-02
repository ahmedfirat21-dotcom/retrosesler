const ai = require('../services/ai');
ai.generateText({ prompt: 'Hello, reply with "OK".' })
  .then(res => {
      console.log('AI Response:', res);
      process.exit(0);
  })
  .catch(err => {
      console.error('AI Error:', err);
      process.exit(1);
  });
