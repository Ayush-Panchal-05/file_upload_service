const express = require('express');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const routes = require('./src/routes/index');

dotenv.config();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const app = express();
app.use(express.json());


app.get('/', (req, res) => {
    res.status(200).send(`Server up and running`);
});
app.use('/api', routes);

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

app.listen(PORT, () => {
    console.log(`Server is running on ${PORT}`);
});