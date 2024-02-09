const cds = require("@sap/cds");

class Service extends cds.ApplicationService {
  async init() {
    this.apis = await this._getAPIS();
    const {
      Tags,
      Types,
      Projects,
      WBSElements,
      Customer,
      CustomersProjects,
    } = this.entities;

    this.on(
      "READ",
      [Tags, Types, Projects, WBSElements, Customer, CustomersProjects],
      async (req, next) => {
        return await this._autoExpand(req, next);
      }
    );

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
    const schemaEntity = this._getSchemaEntity(
      definitions[currentEntityPath]
    ).name.split(".")[0];
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
      if (column.expand) {
        column.previousEntityPath = currentEntityPath;
        column.hadRemote = isFromApi;
        column.path = [];
      }
    });

    await this._autoExpandColumns(data, columns, isFromApi);
    return data;
  }

  async _autoExpandColumns(data, columns) {
    const definitions = cds.model.definitions;
    const expandObjects = [];
    const nextExpands = [];
    columns.forEach((column, idx) => {
      if (!column.expand) return;
      const schemaEntity = this._getSchemaEntity(
        definitions[column.previousEntityPath]
      ).name.split(".")[0];
      if (this.apis.has(schemaEntity)) column.hadRemote = true;
      const expandObject = this._getExpandObject(
        definitions,
        column.previousEntityPath,
        column
      );
      if (expandObject.isRemote) column.hadRemote = true;

      column.expand.forEach((nextColumn) => {
        if (!nextColumn.expand) return;
        nextColumn.previousEntityPath = expandObject.previousEntityPath;
        nextColumn.path = [...column.path, column.ref[0]];
        nextColumn.hadRemote = column.hadRemote;
        nextExpands.push(nextColumn);
      });
      if (!column.hadRemote) return;
      expandObject.index = idx;
      expandObject.path = column.path;
      expandObjects.push(expandObject);
    });

    expandObjects.forEach((expandObject) => {
      if (!expandObject.isRemote) return;
      this._addId(columns, expandObject.associationKey);
    });

    const expands = [];

    for (let i = 0; i < expandObjects.length; i++) {
      const expandObject = expandObjects[i];
      const expandColumns = columns[expandObject.index].expand;
      let expand;
      if (expandObject.isRemote) {
        this._addId(expandColumns, expandObject.key);

        const expandIDs = [
          ...new Set(
            data.reduce((expandColumn, items) => {
              if (!Array.isArray(items)) items = [items];
              items = this._findItem(items, expandObject.path);

              items.forEach((item) => {
                if (item && item[expandObject.associationKey]) {
                  expandColumn.push(item[expandObject.associationKey]);
                }
              });

              return expandColumn;
            }, [])
          ),
        ];

        if (expandIDs.length <= 0) {
          expands.push(null);
          continue;
        }

        const selectColumns = expandColumns.filter((column) => !column.ref);
        expand = this.apis.get(expandObject.service).run(
          SELECT(selectColumns)
            .from(expandObject.entity)
            .where({ [expandObject.key]: expandIDs })
        );
      } else {
        const selectColumns = expandColumns.filter((column) => !column.ref);
        expand = this.run(SELECT(selectColumns).from(expandObject.entity));
      }
      expands.push(expand);
    }

    await Promise.all(expands).then((res) => {
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

    const isFromRemote = entitySchema.query?.source["@cds.external"] || false;

    const service = entitySchema.projection?.from?.ref[0]?.split(".")[0];

    let key;
    let associationKey;
    if (association.keys) {
      key = association.keys[0].ref[0];
      associationKey = association.keys[0].$generatedFieldName;
    } else {
      //on[0] is wrong if $self = ... try consult hannah
      associationKey =
        entitySchema.associations[association.on[0].ref[1]].keys[0].ref[0];
      key =
        entitySchema.associations[association.on[0].ref[1]].keys[0]
          .$generatedFieldName;
    }
    if (!isFromRemote) {
      return {
        isRemote: false,
        associationName: associationName,
        associationKey: associationKey,
        key: key,
        entity: entitySchema,
        previousEntityPath: expandEntityName,
      };
    }
    return {
      isRemote: true,
      associationName: associationName,
      associationKey: associationKey,
      key: key,
      entity: entity,
      service: service,
      previousEntityPath: expandEntityName,
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
    return entity;
  }

  _expand(data, expands, expandObject) {
    const mExpands = new Map();

    expands.forEach((expand) => {
      if (mExpands.has(expand[expandObject.key])) {
        mExpands.set(expand[expandObject.key], [
          ...mExpands.get(expand[expandObject.key]),
          expand,
        ]);
        return;
      }
      mExpands.set(expand[expandObject.key], [expand]);
    });
    mExpands.forEach((expand, key) => {
        if (expand.length === 1) mExpands.set(key, expand[0])
    })
    data.forEach((items) => {
      if (!Array.isArray(items)) items = [items];
      items = this._findItem(items, expandObject.path);

      if (!items) return;
      items.forEach((item) => {
        if (!item) return;
        item[expandObject.associationName] = mExpands.get(
          item[expandObject.associationKey]
        );
      });
    });
  }

  _findItem(items, path) {
    if (path.length === 0) return items;
    items.forEach((item, i) => {
      if (!item[path[0]]) return;
      if (Array.isArray(item[path[0]])) {
        item[path[0]].forEach((item) => {
          items.push(item);
        });
        items.splice(i, 1);
      } else {
        items[i] = item[path[0]];
      }
    });
    items = this._findItem(items, path.slice(1));
    return items;
  }
}
module.exports = Service;
