import { writeToFile } from '@common/files'
import { StructureBackend, SchemaModel } from '@common/types'

import logger from '@log'
import { BackendDirectory } from '../backendDirectory'
const log = logger.getLogger('dataloaders')

export const generateDataloaders = async (backendDirectory: BackendDirectory, models: SchemaModel[], ordered = false) => {
    log.info('generate Dataloaders for all models')
    const body = generateDataloadersWorker(models, ordered)
    backendDirectory.genWrite(`dataloaders`, body)
}

export const generateDataloadersWorker = (models: SchemaModel[], _ordered = false): string => {
    let body = `
  import * as DataLoader from 'dataloader';
  import { UnauthorizedError } from './api-utils';
 
  interface IServiceDataloader {
    find(filter);
    countDocuments(param);
  }

  interface IMyDataloader extends DataLoader<{}, {}>{
    dataloader: any;
    service: IServiceDataloader;
  }
  
  const createDataloder = (service: IServiceDataloader) => {
    const params = { cacheKeyFn: key => key.toString() };
    const dataloader: IMyDataloader = new DataLoader(keys => batchFind(service, keys), params) as IMyDataloader;
  
    dataloader.dataloader = dataloader;
    dataloader.service = service;
  
    return dataloader;
  };
  
  // tslint:disable-next-line:max-line-length
  const load = async (dataloader: IMyDataloader, name: string, ctx, keys: any, loadMany: boolean) => {
    const emptyResults = loadMany ? [] : null;
  
    // nothing to load
    if (!keys || (Array.isArray(keys) && !keys.length)) {
      return emptyResults;
    }
  
    const count = await dataloader.service.countDocuments({_id:{$in:Array.isArray(keys) ? keys : [keys]}});
  
    // we have to do this check if in keys only 1 item, as dataloader cannot handle it
    if (loadMany && keys.length && count === keys.length) {
      return await dataloader.dataloader.loadMany(keys);
    } else if (!loadMany && count === 1){
      return await dataloader.dataloader.load(keys);
    }
  
    // we just log the error, but we don't provide to frontend
    console.error('Not existing id: ' + keys + ' in name: ' + name);
    console.error(ctx.request.body.query);
    console.error(ctx.request.body.variables);
  
    return emptyResults;
  };
  
  const dataloaderByName = async (entry, name: string, service: IServiceDataloader, ctx, listOfIds, loadMany) => {
    if (!listOfIds || (Array.isArray(listOfIds) && !listOfIds.length)) return loadMany ? [] : null;
    const ids = (Array.isArray(listOfIds) ? listOfIds : [listOfIds])
      .map(value => String(value && typeof value === 'object' ? value._id || value.id || value : value));
    const authorizeRead = entry.resolvers?.[name]?.authorizeRead;
    if (typeof authorizeRead !== 'function') throw new UnauthorizedError();
    // Apply the target model's @one policy on every read, including cache hits.
    // Check every ID before accessing the cache or bulk-loading relation records.
    await Promise.all(ids.map(id => authorizeRead({ id }, ctx)));
    const dataloaderName = name + 'Dataloader';
  
    let dataloader;
    if (ctx.req && ctx.req[dataloaderName]){
      dataloader = ctx.req[dataloaderName];
    } else {
      dataloader = createDataloder(service);
      
      // in test with apollo-test-server is mising req
      if(!ctx.req) ctx.req = {}
      ctx.req[dataloaderName] = dataloader;
    }
  
    return await load(
      dataloader,
      name,
      ctx,
      loadMany ? ids : ids[0],
      loadMany,
    );
  };
  
  const processBatches = (keys, callback) => {
    if (Array.isArray(keys) && keys.length) {
      if (Array.isArray(keys[0]) && keys[0].length) {
        return keys.map((subKeys) => {
          return callback(subKeys);
        });
      }
  
      return callback(keys);
    }
  
    if (keys !== undefined && callback) {
      return callback(keys);
    }
  };
  
  const batchFind = async (service: IServiceDataloader, keys) => {
    // tslint:disable-next-line:ter-arrow-parens
    return processBatches(keys, async (batchKeys) => {
      const data = await service.find({_id: {$in: batchKeys}})
      // DataLoader associates values by position, regardless of database result ordering.
      const byId = new Map<string, any>(data.map(row => [String(row._id), row]));
      return batchKeys.map(key => byId.get(String(key))).map(d=>{
        if (!d) return null
        d.id = d._id
        return d
      })
    });
  };
  
  
  export const generateDataloaders = (entry) => {

`

    for (const model of models) {
        const modelName = model.modelName
        const lower = modelName.charAt(0).toLowerCase() + modelName.slice(1)
        body += `

    entry.dataloaders['${lower}'] = async (ctx, ${lower}Ids, loadMany) => {
      return await dataloaderByName(entry, '${lower}', entry.models['${lower}'], ctx, ${lower}Ids, loadMany);
    };
    `
    }

    body += '}\n'

    return body
}
