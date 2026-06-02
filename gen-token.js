require('dotenv').config();
const jwt = require('jsonwebtoken');
const t = jwt.sign({id:'test',nick:'retrotest',role:'user',sid:'test123'}, process.env.JWT_SECRET, {expiresIn:'1h'});
console.log(t);
