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
      const selectColumns = columns?.filter((column) => !column.expand);
      const where = req.query.SELECT.where;
      data = await this.apis
        .get(schemaEntity)
        .run(
          SELECT(selectColumns)
            .from(definitions[currentEntityPath])
            .where(where)
        );
    } else data = await next();

    if (!columns) return data;

    if (!Array.isArray(data)) data = [data];

    for (const column of columns) {
      if (column.expand) {
        column.previousEntityPath = currentEntityPath;
        column.hadRemote = isFromApi;
        column.path = [];
      }
    }

    await this._autoExpandColumns(data, columns, req);
    return data;
  }

  async _autoExpandColumns(data, columns, req) {
    const definitions = cds.model.definitions;
    const expandObjects = [];
    const nextExpands = [];

    for (const [i, column] of columns.entries()) {
      if (!column.expand) continue;

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

      for (const nextColumn of column.expand) {
        if (!nextColumn.expand) continue;
        nextColumn.previousEntityPath = expandObject.previousEntityPath;
        nextColumn.path = [...column.path, column.ref[0]];
        nextColumn.hadRemote = column.hadRemote;
        nextExpands.push(nextColumn);
      }

      if (!column.hadRemote) continue;
      expandObject.index = i;
      expandObject.path = column.path;
      expandObjects.push(expandObject);
    }

    for (const expandObject of expandObjects) {
      if (!expandObject.isRemote) continue;
      this._addId(columns, expandObject.associationKeys);
    }

    for (const [i, expandObject] of expandObjects.entries()) {
      const expandColumns = columns[expandObject.index].expand;
      this._addId(expandColumns, expandObject.keys);
      let j = 0;
      const expandKeys = data
        .reduce((expandColumn, items) => {
          if (!Array.isArray(items)) items = [items];
          items = this._findItem(items, expandObject.path);

          for (const item of items) {
            expandColumn[j] ??= [];

            expandObject.associationKeys.forEach((key) => {
              if (item && item[key]) {
                expandColumn[j].push(item[key]);
              }
            });
            j++;
          }
          return expandColumn;
        }, [])
        .getUnique();

      if (expandKeys.length <= 0) {
        expandObjects.splice(i, 1);
        continue;
      }

      expandObject.expandKeys = expandKeys;
      expandObject.expandColumns = expandColumns.filter(
        (column) => !column.expand
      );
    }

    // array vs map i dont know whats faster. id assume map
    const mExpandObjects = new Map();

    for (const expandObject of expandObjects) {
      const entity = expandObject.entity;
      let expandColumns = expandObject.expandColumns;
      let expandKeys = expandObject.expandKeys;
      if (mExpandObjects.has(expandObject.entity)) {
        const existingObject = mExpandObjects.get(expandObject.entity);
        expandColumns = [
          ...new Set([...expandColumns, ...existingObject.expandColumns]),
        ].getUnique();
        expandKeys = [...expandKeys, ...existingObject.expandKeys].getUnique();
      }

      mExpandObjects.set(entity, {
        entity: entity,
        expandColumns: expandColumns,
        expandKeys: expandKeys,
        isRemote: expandObject.isRemote,
        service: expandObject.service || null,
        expandKeyNames: expandObject.keys,
      });
    }

    const expands = [];
    const expandKeys = [];

    for (const [key, expandObject] of mExpandObjects) {
      let service;
      let where = {};
      let lastWhere = where;
      let columns = expandObject.expandColumns;

      for (const [i, expandKey] of expandObject.expandKeys.entries()) {
        for (const [
          j,
          expandKeyName,
        ] of expandObject.expandKeyNames.entries()) {
          lastWhere[expandKeyName] = expandKey[j];
        }
        if (expandObject.expandKeys[i + 1]) {
          lastWhere.or = {};
          lastWhere = lastWhere.or;
        }
      }
      if (expandObject.isRemote) {
        service = this.apis.get(expandObject.service);
      } else {
        service = this;
      }
      if (columns.indexOf("*") !== -1) columns = ["*"];
      const expand = service.run(
        SELECT(columns).from(expandObject.entity).where(where)
      );
      expandKeys.push(key);
      expands.push(expand);
    }

    let res;
    try {
      res = await Promise.all(expands);
    } catch (e) {
      data = { error: e };
      return req.reject();
    }

    for (const [i, key] of expandKeys.entries()) {
      mExpandObjects.set(key, res[i]);
    }

    for (const expandObject of expandObjects) {
      this._expand(data, mExpandObjects.get(expandObject.entity), expandObject);
    }

    if (nextExpands.length !== 0) {
      await this._autoExpandColumns(data, nextExpands, req);
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

    let keys;
    let associationKeys;

    if (association.keys) {
      const associationKey = association.keys;
      keys = associationKey.reduce((keys, key) => {
        keys.push(key.ref[0]);
        return keys;
      }, []);

      associationKeys = associationKey.reduce((keys, key) => {
        keys.push(key.$generatedFieldName);
        return keys;
      }, []);
    } else {
      let idx = 0;
      if (association.on[0].ref[0] === "$self") {
        idx = 2;
      }
      const associationKey =
        entitySchema.associations[association.on[idx].ref[1]].keys;

      associationKeys = associationKey.reduce((keys, key) => {
        keys.push(key.ref[0]);
        return keys;
      }, []);

      keys = associationKey.reduce((keys, key) => {
        keys.push(key.$generatedFieldName);
        return keys;
      }, []);
    }

    const result = {
      isRemote: isFromRemote,
      associationName: associationName,
      associationKeys: associationKeys,
      keys: keys,
      previousEntityPath: expandEntityName,
      entity: entitySchema,
    };

    if (isFromRemote) {
      result.entity = entity;
      result.service = service;
    }

    return result;
  }

  _addId(columns, keys) {
    const allSelected = columns.indexOf("*") !== -1;
    for (const key of keys) {
      const idSelected = columns.find(
        (column) => column.ref && column.ref.find((ref) => ref == key)
      );

      if (!allSelected && !idSelected) {
        columns.push({ ref: [key] });
      }
    }
  }

  _getSchemaEntity(entity) {
    while (entity.projection) {
      let sParentEntityName = entity.projection.from.ref[0];
      entity = cds.model.definitions[sParentEntityName];
    }
    return entity;
  }

  _expand(data, res, expandObject) {
    const columns = expandObject.expandColumns;
    let expands;
    if (columns.indexOf("*") === -1) {
      let keys = new Set();

      for (const column of columns) keys.add(column?.ref[0]);

      expands = res.reduce((expands, expand) => {
        const expandKeys = Object.keys(expand);
        let object = {};

        for (const key of expandKeys) {
          if (keys.has(key)) {
            object[key] = expand[key];
          }
        }
        expands.push(object);
        return expands;
      }, []);
    } else expands = res;

    const mExpands = new Map();

    for (const expand of expands) {
      let keys = [];

      for (const key of expandObject.keys) keys.push(expand[key]);

      keys = keys.join("::");
      if (mExpands.has(keys)) {
        mExpands.set(keys, [...mExpands.get(keys), expand]);
        continue;
      }

      mExpands.set(keys, [expand]);
    }

    for (let items of data) {
      if (!Array.isArray(items)) items = [items];
      items = this._findItem(items, expandObject.path);

      if (!items) continue;
      for (const item of items) {
        if (!item) continue;

        let keys = [];

        for (const key of expandObject.associationKeys) {
          keys.push(item[key]);
        }
        keys = keys.join("::");

        item[expandObject.associationName] = mExpands.get(keys);
      }
    }
  }

  _findItem(items, path) {
    if (path.length === 0) return items;

    for (const [i, item] of items.entries()) {
      if (!item[path[0]]) {
        items.splice(i, 1);
        continue;
      }

      if (Array.isArray(item[path[0]])) {
        item[path[0]].forEach((item) => {
          items.push(item);
        });

        items.splice(i, 1);
      } else {
        items[i] = item[path[0]];
      }
    }
    items = this._findItem(items, path.slice(1));
    return items;
  }
}
module.exports = Service;

Array.prototype.getUnique = function () {
  return this.filter((a) => !(0 - (this[a] = ++this[a] | 0)));
};

// IDs used only for expand arend deleted afterwards
