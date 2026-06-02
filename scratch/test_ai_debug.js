require('dotenv').config();
const ai = require('../services/ai');
console.log('API Key in process.env:', process.env.GEMINI_API_KEY);
ai.generateText({ prompt: 'hi' })
  .then(res => {
      console.log('AI Success:', res);
      process.exit(0);
  })
  .catch(err => {
      console.error('AI Error:', err);
      process.exit(1);
  });
