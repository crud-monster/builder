const dotenvFlow: { config(options: { default_node_env: string }): unknown } = require('dotenv-flow')
import * as database from './database'

dotenvFlow.config({ default_node_env: 'development' })

database.migrate(process.argv[2] || 'up')
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1 })
    .finally(() => database.close())
