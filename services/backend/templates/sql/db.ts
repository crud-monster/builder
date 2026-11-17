import * as database from '../sql/database'
import type { ConnectionOptions } from '../sql/types'

export const status: { connection: string; status: string; lastError: unknown } = { connection: 'sql', status: 'not connected', lastError: null }
export const connect = async (options: ConnectionOptions = {}) => {
    try {
        const connection = database.getConnection(options)
        await connection.raw('SELECT 1')
        await database.assertCurrent()
        status.status = 'connected'
        return connection
    } catch (error) {
        status.lastError = error
        status.status = 'error'
        throw error
    }
}
export const close = async () => { await database.close(); status.status = 'disconnected' }
export const disconnect = close
export const disconnectAndWait = close
