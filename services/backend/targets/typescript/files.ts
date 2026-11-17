import * as fs from 'fs'
import * as path from 'path'
import { templateToText } from '../../../common/files'

export const templateFileToText = (fileName: string, params: any = null): string => {
    // Explicit paths retain their existing resolution relative to the working directory.
    const templateFilePath = (fileName.startsWith('C:') || fileName.startsWith('.') || fileName.startsWith('/'))
        ? fileName
        : path.join(__dirname, 'templates', fileName)
    return templateToText(fs.readFileSync(templateFilePath).toString(), params)
}
