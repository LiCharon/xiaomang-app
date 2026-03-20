const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const PORT = process.env.PORT || 5001;
const app = require('./app');
const { connectToDatabase } = require('./lib/db');

if (require.main === module) {
  connectToDatabase()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`🚀 服务器运行在 http://localhost:${PORT}`);
      });
    })
    .catch((error) => {
      console.error('❌ MongoDB 连接失败:', error.message);
      process.exit(1);
    });
}

module.exports = app;
