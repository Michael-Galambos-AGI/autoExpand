const cds = require("@sap/cds");

class Service extends cds.ApplicationService {
  async init() {
    this.apis = await this._getAPIS();
    const { Tags, Types, Projects, WBSElements } = this.entities;

    this.on("READ", [Tags, Types, Projects, WBSElements], async (req, next) => {
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

  _getExpandObject(definitions, currentEntity, column) {
    const associationName = column.ref[0];
    const association =
      definitions[currentEntity].associations[associationName];

    const expandEntityName = association.target;
    const entity = definitions[expandEntityName];

    const entitySchemaPath = entity.projection.from.ref[0];
    const entitySchema = definitions[entitySchemaPath];

    const isFromRemote = entitySchema.query?.source["@cds.external"];
    //definitions[currentEntity].elements.filter((element) => element.key)
    if (!isFromRemote) {
      const key =
        entitySchema.associations[association.on[0].ref[1]].keys[0].ref[0];
      const associationKey =
        entitySchema.associations[association.on[0].ref[1]].keys[0]
          .$generatedFieldName;
      return {
        isRemote: false,
        associationName: associationName,
        associationKey: associationKey,
        key: key,
        entity: entitySchema,
      };
    }
    // TODO: Test if propper key & multi key
    const key = association.keys[0].ref[0];
    const associationKey = association.keys[0].$generatedFieldName;
    const service = entitySchema.projection.from.ref[0].split(".")[0];
    return {
      isRemote: true,
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

    const expandObjects = [];

    for (let i = 0; i < columns.length; i++) {
      if (!columns[i].expand) continue;

      const expandObject = this._getExpandObject(
        definitions,
        currentEntity,
        columns[i]
      );
      if (!isFromApi && !expandObject.isRemote) continue;
      expandObject.index = i;
      expandObjects.push(expandObject);
    }

    expandObjects.forEach((expandObject) => {
      if (!expandObject.isRemote) return;
      this._addId(columns, expandObject.associationKey);
    });

    let data;

    if (isFromApi) {
      const selectColumns = columns.filter((column) => !column.ref);
      data = await this.apis
        .get(schemaEntity)
        .run(SELECT(selectColumns).from(definitions[currentEntity]).where());
    } else data = await next();

    if (!Array.isArray(data)) {
      data = [data];
    }

    for (let i = 0; i < expandObjects.length; i++) {
      const expandObject = expandObjects[i];
      const expandColumns = columns[expandObject.index].expand;

      if (expandObject.isRemote) {
        this._addId(expandColumns, expandObject.key);

        const expandIDs = [
          ...new Set(
            data.reduce((expandColumn, item) => {
              if (item[expandObject.associationKey]) {
                expandColumn.push(item[expandObject.associationKey]);
              }
              return expandColumn;
            }, [])
          ),
        ];

        if (expandIDs.length <= 0) {
          continue;
        }

        const expands = await this.apis.get(expandObject.service).run(
          SELECT(expandColumns)
            .from(expandObject.entity)
            .where({ [expandObject.key]: expandIDs })
        );

        const mExpands = new Map(expands.map((expand) => [expand[expandObject.key], expand]));

        data.forEach((item) => {
          item[expandObject.associationName] = mExpands.get(
            item[expandObject.associationKey]
          );
          delete item[expandObject.associationKey];
        });
      } else {
        const expands = await this.run(
          SELECT(expandColumns)
            .from(expandObject.entity)
            .where(`${[expandObject.associationKey]} IS NOT NULL`)
        );
        const mExpands = new Map(expands.map((expand) => [expand[expandObject.associationKey], expand]));
        data.forEach((item) => {
          item[expandObject.associationName] = mExpands.get(
            item[expandObject.key]
          );
          delete item[expandObject.associationKey];
        });
      }
    }
    return data;
  }
}
module.exports = Service;
