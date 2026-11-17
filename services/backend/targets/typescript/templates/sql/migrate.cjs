require('dotenv-flow').config({ default_node_env: 'development' })
const database = require('./sql/database.cjs')

database.migrate(process.argv[2] || 'up')
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1 })
    .finally(() => database.close())
