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

  async _autoExpand(req, next) {
    const columns = req.query.SELECT.columns;
    const currentEntityPath = cds.context.path;
    const definitions = cds.model.definitions;

    const schemaEntity = this._getSchemaEntity(definitions[currentEntityPath]);
    const isFromApi = this.apis.has(schemaEntity);
    let data;
    if (isFromApi) {
      const selectColumns = columns?.filter((column) => !column.ref);
      data = await this.apis
        .get(schemaEntity)
        .run(
          SELECT(selectColumns).from(definitions[currentEntityPath]).where()
        );
    } else data = await next();
    if (!columns) return data;
    if (!Array.isArray(data)) {
      data = [data];
    }
    columns.forEach((column) => {
      if (column.expand) column.parentEntityPath = currentEntityPath;
    });

    await this._autoExpandColumns(data, columns);
    return data;
  }

  async _autoExpandColumns(data, columns) {
    const definitions = cds.model.definitions;
    const expandObjects = [];
    const nextExpands = [];
    columns.forEach((column, idx) => {
      if (!column.expand) return;
      column.path ??= [];
      const schemaEntity = this._getSchemaEntity(
        definitions[column.parentEntityPath]
      );
      const isFromApi = this.apis.has(schemaEntity);
      const expandObject = this._getExpandObject(
        definitions,
        column.parentEntityPath,
        column
      );
      column.expand.forEach((col) => {
        if (!col.expand) return;
        col.parentEntityPath = expandObject.parentEntityPath;
        col.path = [...column.path, column.ref[0]];
        col.path.push();
        nextExpands.push(col);
      });
      if (!expandObject.isRemote && !isFromApi) return;
      expandObject.index = idx;
      expandObject.path = column.path;
      expandObjects.push(expandObject);
    });

    expandObjects.forEach((expandObject) => {
      if (!expandObject.isRemote) return;
      this._addId(columns, expandObject.associationKey);
    });

    const aExpands = [];

    for (let i = 0; i < expandObjects.length; i++) {
      const expandObject = expandObjects[i];
      const expandColumns = columns[expandObject.index].expand;
      let pExpand;
      if (expandObject.isRemote) {
        this._addId(expandColumns, expandObject.key);

        const expandIDs = [
          ...new Set(
            data.reduce((expandColumn, items) => {
              expandObject.path.forEach((element) => {
                if (items[element]) {
                  items = items[element];
                }
              });
              if (!Array.isArray(items)) items = [items];
              items.forEach((item) => {
                if (item[expandObject.associationKey]) {
                  expandColumn.push(item[expandObject.associationKey]);
                }
              });

              return expandColumn;
            }, [])
          ),
        ];

        if (expandIDs.length <= 0) {
          aExpands.push(null);
          continue;
        }

        pExpand = this.apis.get(expandObject.service).run(
          SELECT(expandColumns)
            .from(expandObject.entity)
            .where({ [expandObject.key]: expandIDs })
        );
      } else {
        //const selectColumns = expandColumns.filter((column) => !column.ref);
        pExpand = this.run(SELECT(expandColumns).from(expandObject.entity));
      }
      aExpands.push(pExpand);
    }

    await Promise.all(aExpands).then((res) => {
      for (let i = 0; i < res.length; i++) {
        if (!res[i]) continue;
        this._expand(data, res[i], expandObjects[i]);
      }
    });

    if (nextExpands.length !== 0) {
      await this._autoExpandColumns(data, nextExpands);
    }
    return data;
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

    const service = entitySchema.projection?.from?.ref[0]?.split(".")[0];

    let key;
    let associationKey;
    if (association.keys) {
      key = association.keys[0].ref[0];
      associationKey = association.keys[0].$generatedFieldName;
    } else {
      associationKey =
        entitySchema.associations[association.on[0].ref[1]].keys[0].ref[0];
      key =
        entitySchema.associations[association.on[0].ref[1]].keys[0]
          .$generatedFieldName;
    }

    //definitions[currentEntity].elements.filter((element) => element.key)
    if (!isFromRemote) {
      return {
        isRemote: false,
        associationName: associationName,
        associationKey: associationKey,
        key: key,
        entity: entitySchema,
        parentEntityPath: expandEntityName,
      };
    }
    // TODO: Test if propper key & multi key

    return {
      isRemote: true,
      associationName: associationName,
      associationKey: associationKey,
      key: key,
      entity: entity,
      service: service,
      parentEntityPath: expandEntityName,
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

  _getSchemaEntity(entity) {
    while (entity.projection) {
      let sParentEntityName = entity.projection.from.ref[0];
      entity = cds.model.definitions[sParentEntityName];
    }
    return entity.name.split(".")[0];
  }

  _expand(data, expands, expandObject) {
    const mExpands = new Map(
      expands.map((expand) => [expand[expandObject.key], expand])
    );
    data.forEach((items) => {
      expandObject.path.forEach((element) => {
        if (items && items[element]) {
          items = items[element];
        } else items = undefined
      });
      if (!items) return
      if (!Array.isArray(items)) items = [items];
      items.forEach((item) => {
        item[expandObject.associationName] = mExpands.get(
          item[expandObject.associationKey]
        );
        delete item[expandObject.associationKey];
      });
    });
  }
}
module.exports = Service;
