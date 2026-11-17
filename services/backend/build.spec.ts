import { SchemaModel, SchemaModelRelation, SchemaModelType } from "../common/types"
import { BackendDirectory } from "./targets/typescript/backendDirectory"
import { generateAll } from "./build"
import {generateMongoModelToFile} from './targets/typescript/generators/model'
import {createModelTypeFromModel} from './targets/typescript/generators/model-types'
import { generateSchema } from './targets/typescript/generators/schema'
import { generateResolverToFile } from './targets/typescript/generators/resolvers'
import { generateServiceToFile } from './targets/typescript/generators/service'
import { generateRestToFile } from './targets/typescript/generators/rest'
import { SchemaType } from "mongoose"

jest.mock('./targets/typescript/generators/model')
jest.mock('./targets/typescript/generators/model-types')
jest.mock('./targets/typescript/generators/schema')
jest.mock('./targets/typescript/generators/resolvers')
jest.mock('./targets/typescript/generators/service')
jest.mock('./targets/typescript/generators/rest')

  describe('generate:build', ()=>{
       
    it('should call 2x createTypescriptType and 1x writeToFile inside generateTypescriptTypes', ()=>{
        const backendDirectory = new BackendDirectory()
        backendDirectory.genWrite = jest.fn()
        backendDirectory.modelsWrite = jest.fn()
        backendDirectory.servicesWrite = jest.fn()
        backendDirectory.resolversWrite = jest.fn()

        // (modelGenerator as any).generateMongoModelToFile = jest.fn()

        const modelTodo = {
          modelName: 'Todo',
          type: SchemaModelType.MODEL,
          members:[
            {
              name: 'email',
              type: 'String'
            },
            {
              name: 'virtual',
              type: 'String',
              isVirtual: true
            }
          ]
      } as SchemaModel

      const modelUser = {
        modelName: 'User',
        type: SchemaModelType.ENTITY,
        members: [{
            name: 'email',
            type: 'String'
        },{
            name: 'password',
            type: 'Boolean',
            isVirtual: true
        },{
            name: 'todos',
            type: 'Todo',
            isArray: true,
            relation:{
                relatedModel:{modelName: 'Todo'}
            } as SchemaModelRelation
        }]
    } as SchemaModel


        generateAll(backendDirectory, [modelTodo, modelUser], {})

        expect(generateSchema).toBeCalledTimes(1)

        expect(generateMongoModelToFile).toBeCalledTimes(2)
        expect((generateMongoModelToFile as any).mock.calls[0]).toEqual([backendDirectory, modelTodo, expect.not.arrayContaining([expect.objectContaining({isVirtual:true})])])
        expect((generateMongoModelToFile as any).mock.calls[1]).toEqual([backendDirectory, modelUser, expect.not.arrayContaining([expect.objectContaining({isVirtual:true})])])
        
        expect(createModelTypeFromModel).toBeCalledTimes(2)
        expect((createModelTypeFromModel as any).mock.calls).toEqual(expect.arrayContaining([
          [modelTodo, expect.not.arrayContaining([expect.objectContaining({isVirtual:true})])],
          [modelUser, expect.not.arrayContaining([expect.objectContaining({isVirtual:true})])]
        ]))
        
        
        expect(generateServiceToFile).toBeCalledTimes(2)
        expect((generateServiceToFile as any).mock.calls).toEqual(expect.arrayContaining([
          [backendDirectory, modelTodo],
          [backendDirectory, modelUser]
        ]))

        expect(generateResolverToFile).toBeCalledTimes(1)
        expect(generateRestToFile).toBeCalledTimes(1)
        expect(generateRestToFile).toBeCalledWith(backendDirectory, modelTodo)
        expect((generateResolverToFile as any).mock.calls).toEqual(expect.arrayContaining([
          [backendDirectory, expect.not.objectContaining({type: SchemaModelType.ENTITY})]
        ]))
        
        const modelTypesCall = (backendDirectory.genWrite as any).mock.calls.find((calls=>calls[0]=='model-types.ts'))
        expect(modelTypesCall).toBeDefined()

        const dataloadersCall = (backendDirectory.genWrite as any).mock.calls.find((calls=>calls[0]=='dataloaders'))
        expect(dataloadersCall).toBeDefined()

        const entryCall = (backendDirectory.genWrite as any).mock.calls.find((calls=>calls[0]=='entry'))
        expect(entryCall).toBeDefined()

    })

})

