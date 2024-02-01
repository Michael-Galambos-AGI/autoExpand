const cds = require("@sap/cds");

class Service extends cds.ApplicationService {
  async init() {
    this.apis = await this._getAPIS();
    const { Tags, Types } = this.entities;

    this.on("READ", "*", async (req, next) => {
      return await this._autoExpand(req, next);
    });

    return super.init();
  }

  async _getAPIS() {
    const services = Object.values(cds.model.services);
    const promises = services
      .filter((service) => service["@cds.external"])
      .map((service) => {
        return cds.connect.to(service.name);
      });
    const apis = await Promise.all(promises);
    return new Map(apis.map((api) => [api.name, api]));
  }

  _getRemoteObject(definitions, currentEntity, column) {
    const associationName = column.ref[0];
    const association =
      definitions[currentEntity].associations[associationName];

    const expandEntityName = association.target;
    const entity = definitions[expandEntityName];

    const entitySchemaPath = entity.projection.from.ref[0];
    const entitySchema = definitions[entitySchemaPath];

    const isFromRemote = entitySchema.query?.source["@cds.external"];

    if (!isFromRemote) {
      return undefined;
    }
    // TODO: Test if propper key & multi key
    const key = association.keys[0].ref[0];
    const associationKey = association.keys[0].$generatedFieldName;
    const service = entitySchema.projection.from.ref[0].split(".")[0];
    return {
      associationName: associationName,
      associationKey: associationKey,
      key: key,
      entity: entity,
      service: service,
    };
  }

  _addId(columns, id) {
    const allSelected = columns.indexOf("*") !== -1;
    const idSelected = columns.find(
      (column) => column.ref && column.ref.find((ref) => ref == id)
    );

    if (!allSelected && !idSelected) {
      columns.push({ ref: [id] });
    }
  }

  async _autoExpand(req, next) {
    const columns = req.query.SELECT.columns;

    const definitions = cds.model.definitions;
    const currentEntity = cds.context.path;

    let oEntity = definitions[currentEntity];
    while (oEntity.projection) {
      let sParentEntityName = oEntity.projection.from.ref[0];
      oEntity = cds.model.definitions[sParentEntityName];
    }
    const schemaEntity = oEntity.name.split(".")[0];
    const isFromApi = this.apis.has(schemaEntity);

    if (isFromApi && !columns)
      return await this.apis.get(schemaEntity).run(req.query);

    if (!columns) return next();

    const remoteObjects = [];

    for (let i = 0; i < columns.length; i++) {
      if (!columns[i].expand) {
        continue;
      }

      const remoteObject = this._getRemoteObject(
        definitions,
        currentEntity,
        columns[i]
      );
      if (remoteObject) {
        remoteObject.index = i;
        remoteObjects.push(remoteObject);
      } else if (isFromApi) {
        // columns.splice(columns.indexOf(columns[i]),1)
      }
    }

    remoteObjects.forEach((remoteObject) => {
      this._addId(columns, remoteObject.associationKey);
    });

    let data;

    if (isFromApi) {
      // delete req.query.SELECT.columns
      data = await this.apis
        .get(schemaEntity)
        .run(SELECT(["*"]).from(definitions[currentEntity]));
    } else data = await next();

    if (!Array.isArray(data)) {
      data = [data];
    }

    for (let i = 0; i < remoteObjects.length; i++) {
      const remoteObject = remoteObjects[i];
      const expandColumns = columns[remoteObject.index].expand;

      this._addId(expandColumns, remoteObject.key);

      const expandIDs = [
        ...new Set(
          data.reduce((expandColumn, item) => {
            if (item[remoteObject.associationKey]) {
              expandColumn.push(item[remoteObject.associationKey]);
            }
            return expandColumn;
          }, [])
        ),
      ];

      if (expandIDs.length <= 0) {
        continue;
      }

      const expands = await this.apis.get(remoteObject.service).run(
        SELECT(expandColumns)
          .from(remoteObject.entity)
          .where({ [remoteObject.key]: expandIDs })
      );

      const mExpands = new Map(expands.map((expand) => [expand.ID, expand]));

      data.forEach((item) => {
        item[remoteObject.associationName] = mExpands.get(
          item[remoteObject.associationKey]
        );
        delete item[remoteObject.associationKey];
      });
    }
  }
}
module.exports = Service;
