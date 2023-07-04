"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InsertQueryBuilder = void 0;
const uuid_1 = require("uuid");
const DriverUtils_1 = require("../driver/DriverUtils");
const error_1 = require("../error");
const InsertValuesMissingError_1 = require("../error/InsertValuesMissingError");
const ReturningStatementNotSupportedError_1 = require("../error/ReturningStatementNotSupportedError");
const BroadcasterResult_1 = require("../subscriber/BroadcasterResult");
const InstanceChecker_1 = require("../util/InstanceChecker");
const ObjectUtils_1 = require("../util/ObjectUtils");
const QueryBuilder_1 = require("./QueryBuilder");
const InsertResult_1 = require("./result/InsertResult");
const ReturningResultsEntityUpdator_1 = require("./ReturningResultsEntityUpdator");
/**
 * Allows to build complex sql queries in a fashion way and execute those queries.
 */
class InsertQueryBuilder extends QueryBuilder_1.QueryBuilder {
    constructor() {
        super(...arguments);
        this["@instanceof"] = Symbol.for("InsertQueryBuilder");
    }
    // -------------------------------------------------------------------------
    // Public Implemented Methods
    // -------------------------------------------------------------------------
    /**
     * Gets generated SQL query without parameters being replaced.
     */
    getQuery() {
        let sql = this.createComment();
        sql += this.createCteExpression();
        sql += this.createInsertExpression();
        return sql.trim();
    }
    /**
     * Executes sql generated by query builder and returns raw database results.
     */
    async execute() {
        // console.time(".value sets");
        const valueSets = this.getValueSets();
        // console.timeEnd(".value sets");
        // If user passed empty array of entities then we don't need to do
        // anything.
        //
        // Fixes GitHub issues #3111 and #5734. If we were to let this through
        // we would run into problems downstream, like subscribers getting
        // invoked with the empty array where they expect an entity, and SQL
        // queries with an empty VALUES clause.
        if (valueSets.length === 0)
            return new InsertResult_1.InsertResult();
        // console.time("QueryBuilder.execute");
        // console.time(".database stuff");
        const queryRunner = this.obtainQueryRunner();
        let transactionStartedByUs = false;
        try {
            // start transaction if it was enabled
            if (this.expressionMap.useTransaction === true &&
                queryRunner.isTransactionActive === false) {
                await queryRunner.startTransaction();
                transactionStartedByUs = true;
            }
            // console.timeEnd(".database stuff");
            // call before insertion methods in listeners and subscribers
            if (this.expressionMap.callListeners === true &&
                this.expressionMap.mainAlias.hasMetadata) {
                const broadcastResult = new BroadcasterResult_1.BroadcasterResult();
                valueSets.forEach((valueSet) => {
                    queryRunner.broadcaster.broadcastBeforeInsertEvent(broadcastResult, this.expressionMap.mainAlias.metadata, valueSet);
                });
                await broadcastResult.wait();
            }
            let declareSql = null;
            let selectOutputSql = null;
            // if update entity mode is enabled we may need extra columns for the returning statement
            // console.time(".prepare returning statement");
            const returningResultsEntityUpdator = new ReturningResultsEntityUpdator_1.ReturningResultsEntityUpdator(queryRunner, this.expressionMap);
            const returningColumns = [];
            if (Array.isArray(this.expressionMap.returning) &&
                this.expressionMap.mainAlias.hasMetadata) {
                for (const columnPath of this.expressionMap.returning) {
                    returningColumns.push(...this.expressionMap.mainAlias.metadata.findColumnsWithPropertyPath(columnPath));
                }
            }
            if (this.expressionMap.updateEntity === true &&
                this.expressionMap.mainAlias.hasMetadata) {
                if (!(valueSets.length > 1 &&
                    this.connection.driver.options.type === "oracle")) {
                    this.expressionMap.extraReturningColumns =
                        this.expressionMap.mainAlias.metadata.getInsertionReturningColumns();
                }
                returningColumns.push(...this.expressionMap.extraReturningColumns.filter((c) => !returningColumns.includes(c)));
            }
            if (returningColumns.length > 0 &&
                this.connection.driver.options.type === "mssql") {
                declareSql = this.connection.driver.buildTableVariableDeclaration("@OutputTable", returningColumns);
                selectOutputSql = `SELECT * FROM @OutputTable`;
            }
            // console.timeEnd(".prepare returning statement");
            // execute query
            // console.time(".getting query and parameters");
            const [insertSql, parameters] = this.getQueryAndParameters();
            // console.timeEnd(".getting query and parameters");
            // console.time(".query execution by database");
            const statements = [declareSql, insertSql, selectOutputSql];
            const sql = statements.filter((s) => s != null).join(";\n\n");
            const queryResult = await queryRunner.query(sql, parameters, true);
            const insertResult = InsertResult_1.InsertResult.from(queryResult);
            // console.timeEnd(".query execution by database");
            // load returning results and set them to the entity if entity updation is enabled
            if (this.expressionMap.updateEntity === true &&
                this.expressionMap.mainAlias.hasMetadata) {
                // console.time(".updating entity");
                await returningResultsEntityUpdator.insert(insertResult, valueSets);
                // console.timeEnd(".updating entity");
            }
            // call after insertion methods in listeners and subscribers
            if (this.expressionMap.callListeners === true &&
                this.expressionMap.mainAlias.hasMetadata) {
                const broadcastResult = new BroadcasterResult_1.BroadcasterResult();
                valueSets.forEach((valueSet) => {
                    queryRunner.broadcaster.broadcastAfterInsertEvent(broadcastResult, this.expressionMap.mainAlias.metadata, valueSet);
                });
                await broadcastResult.wait();
            }
            // close transaction if we started it
            // console.time(".commit");
            if (transactionStartedByUs) {
                await queryRunner.commitTransaction();
            }
            // console.timeEnd(".commit");
            return insertResult;
        }
        catch (error) {
            // rollback transaction if we started it
            if (transactionStartedByUs) {
                try {
                    await queryRunner.rollbackTransaction();
                }
                catch (rollbackError) { }
            }
            throw error;
        }
        finally {
            // console.time(".releasing connection");
            if (queryRunner !== this.queryRunner) {
                // means we created our own query runner
                await queryRunner.release();
            }
            // console.timeEnd(".releasing connection");
            // console.timeEnd("QueryBuilder.execute");
        }
    }
    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------
    /**
     * Specifies INTO which entity's table insertion will be executed.
     */
    into(entityTarget, columns) {
        entityTarget = InstanceChecker_1.InstanceChecker.isEntitySchema(entityTarget)
            ? entityTarget.options.name
            : entityTarget;
        const mainAlias = this.createFromAlias(entityTarget);
        this.expressionMap.setMainAlias(mainAlias);
        this.expressionMap.insertColumns = columns || [];
        return this;
    }
    /**
     * Values needs to be inserted into table.
     */
    values(values) {
        this.expressionMap.valuesSet = values;
        return this;
    }
    /**
     * Optional returning/output clause.
     */
    output(output) {
        return this.returning(output);
    }
    /**
     * Optional returning/output clause.
     */
    returning(returning) {
        // not all databases support returning/output cause
        if (!this.connection.driver.isReturningSqlSupported("insert")) {
            throw new ReturningStatementNotSupportedError_1.ReturningStatementNotSupportedError();
        }
        this.expressionMap.returning = returning;
        return this;
    }
    /**
     * Indicates if entity must be updated after insertion operations.
     * This may produce extra query or use RETURNING / OUTPUT statement (depend on database).
     * Enabled by default.
     */
    updateEntity(enabled) {
        this.expressionMap.updateEntity = enabled;
        return this;
    }
    /**
     * Adds additional ON CONFLICT statement supported in postgres and cockroach.
     *
     * @deprecated Use `orIgnore` or `orUpdate`
     */
    onConflict(statement) {
        this.expressionMap.onConflict = statement;
        return this;
    }
    /**
     * Adds additional ignore statement supported in databases.
     */
    orIgnore(statement = true) {
        this.expressionMap.onIgnore = !!statement;
        return this;
    }
    /**
     * Adds additional update statement supported in databases.
     */
    orUpdate(statementOrOverwrite, conflictTarget, orUpdateOptions) {
        if (!Array.isArray(statementOrOverwrite)) {
            this.expressionMap.onUpdate = {
                conflict: statementOrOverwrite === null || statementOrOverwrite === void 0 ? void 0 : statementOrOverwrite.conflict_target,
                columns: statementOrOverwrite === null || statementOrOverwrite === void 0 ? void 0 : statementOrOverwrite.columns,
                overwrite: statementOrOverwrite === null || statementOrOverwrite === void 0 ? void 0 : statementOrOverwrite.overwrite,
                skipUpdateIfNoValuesChanged: orUpdateOptions === null || orUpdateOptions === void 0 ? void 0 : orUpdateOptions.skipUpdateIfNoValuesChanged,
                upsertType: orUpdateOptions === null || orUpdateOptions === void 0 ? void 0 : orUpdateOptions.upsertType,
            };
            return this;
        }
        this.expressionMap.onUpdate = {
            overwrite: statementOrOverwrite,
            conflict: conflictTarget,
            skipUpdateIfNoValuesChanged: orUpdateOptions === null || orUpdateOptions === void 0 ? void 0 : orUpdateOptions.skipUpdateIfNoValuesChanged,
            indexPredicate: orUpdateOptions === null || orUpdateOptions === void 0 ? void 0 : orUpdateOptions.indexPredicate,
            upsertType: orUpdateOptions === null || orUpdateOptions === void 0 ? void 0 : orUpdateOptions.upsertType,
        };
        return this;
    }
    // -------------------------------------------------------------------------
    // Protected Methods
    // -------------------------------------------------------------------------
    /**
     * Creates INSERT express used to perform insert query.
     */
    createInsertExpression() {
        var _a, _b;
        const tableName = this.getTableName(this.getMainTableName());
        const valuesExpression = this.createValuesExpression(); // its important to get values before returning expression because oracle rely on native parameters and ordering of them is important
        const returningExpression = this.connection.driver.options.type === "oracle" &&
            this.getValueSets().length > 1
            ? null
            : this.createReturningExpression("insert"); // oracle doesnt support returning with multi-row insert
        const columnsExpression = this.createColumnNamesExpression();
        let query = "INSERT ";
        if (((_a = this.expressionMap.onUpdate) === null || _a === void 0 ? void 0 : _a.upsertType) === "primary-key") {
            query = "UPSERT ";
        }
        if (DriverUtils_1.DriverUtils.isMySQLFamily(this.connection.driver) ||
            this.connection.driver.options.type === "aurora-mysql") {
            query += `${this.expressionMap.onIgnore ? " IGNORE " : ""}`;
        }
        query += `INTO ${tableName}`;
        if (this.alias !== this.getMainTableName() &&
            DriverUtils_1.DriverUtils.isPostgresFamily(this.connection.driver)) {
            query += ` AS "${this.alias}"`;
        }
        // add columns expression
        if (columnsExpression) {
            query += `(${columnsExpression})`;
        }
        else {
            if (!valuesExpression &&
                (DriverUtils_1.DriverUtils.isMySQLFamily(this.connection.driver) ||
                    this.connection.driver.options.type === "aurora-mysql"))
                // special syntax for mysql DEFAULT VALUES insertion
                query += "()";
        }
        // add OUTPUT expression
        if (returningExpression &&
            this.connection.driver.options.type === "mssql") {
            query += ` OUTPUT ${returningExpression}`;
        }
        // add VALUES expression
        if (valuesExpression) {
            if (this.connection.driver.options.type === "oracle" &&
                this.getValueSets().length > 1) {
                query += ` ${valuesExpression}`;
            }
            else {
                query += ` VALUES ${valuesExpression}`;
            }
        }
        else {
            if (DriverUtils_1.DriverUtils.isMySQLFamily(this.connection.driver) ||
                this.connection.driver.options.type === "aurora-mysql") {
                // special syntax for mysql DEFAULT VALUES insertion
                query += " VALUES ()";
            }
            else {
                query += ` DEFAULT VALUES`;
            }
        }
        if (((_b = this.expressionMap.onUpdate) === null || _b === void 0 ? void 0 : _b.upsertType) !== "primary-key") {
            if (this.connection.driver.supportedUpsertTypes.includes("on-conflict-do-update")) {
                if (this.expressionMap.onIgnore) {
                    query += " ON CONFLICT DO NOTHING ";
                }
                else if (this.expressionMap.onConflict) {
                    query += ` ON CONFLICT ${this.expressionMap.onConflict} `;
                }
                else if (this.expressionMap.onUpdate) {
                    const { overwrite, columns, conflict, skipUpdateIfNoValuesChanged, indexPredicate, } = this.expressionMap.onUpdate;
                    let conflictTarget = "ON CONFLICT";
                    if (Array.isArray(conflict)) {
                        conflictTarget += ` ( ${conflict
                            .map((column) => this.escape(column))
                            .join(", ")} )`;
                        if (indexPredicate &&
                            !DriverUtils_1.DriverUtils.isPostgresFamily(this.connection.driver)) {
                            throw new error_1.TypeORMError(`indexPredicate option is not supported by the current database driver`);
                        }
                        if (indexPredicate &&
                            DriverUtils_1.DriverUtils.isPostgresFamily(this.connection.driver)) {
                            conflictTarget += ` WHERE ( ${this.escape(indexPredicate)} )`;
                        }
                    }
                    else if (conflict) {
                        conflictTarget += ` ON CONSTRAINT ${this.escape(conflict)}`;
                    }
                    if (Array.isArray(overwrite)) {
                        query += ` ${conflictTarget} DO UPDATE SET `;
                        query += overwrite === null || overwrite === void 0 ? void 0 : overwrite.map((column) => `${this.escape(column)} = EXCLUDED.${this.escape(column)}`).join(", ");
                        query += " ";
                    }
                    else if (columns) {
                        query += ` ${conflictTarget} DO UPDATE SET `;
                        query += columns
                            .map((column) => `${this.escape(column)} = :${column}`)
                            .join(", ");
                        query += " ";
                    }
                    if (Array.isArray(overwrite) &&
                        skipUpdateIfNoValuesChanged &&
                        DriverUtils_1.DriverUtils.isPostgresFamily(this.connection.driver)) {
                        query += ` WHERE (`;
                        query += overwrite
                            .map((column) => `${tableName}.${this.escape(column)} IS DISTINCT FROM EXCLUDED.${this.escape(column)}`)
                            .join(" OR ");
                        query += ") ";
                    }
                }
            }
            else if (this.connection.driver.supportedUpsertTypes.includes("on-duplicate-key-update")) {
                if (this.expressionMap.onUpdate) {
                    const { overwrite, columns } = this.expressionMap.onUpdate;
                    if (Array.isArray(overwrite)) {
                        query += " ON DUPLICATE KEY UPDATE ";
                        query += overwrite
                            .map((column) => `${this.escape(column)} = VALUES(${this.escape(column)})`)
                            .join(", ");
                        query += " ";
                    }
                    else if (Array.isArray(columns)) {
                        query += " ON DUPLICATE KEY UPDATE ";
                        query += columns
                            .map((column) => `${this.escape(column)} = :${column}`)
                            .join(", ");
                        query += " ";
                    }
                }
            }
            else {
                if (this.expressionMap.onUpdate) {
                    throw new error_1.TypeORMError(`onUpdate is not supported by the current database driver`);
                }
            }
        }
        // add RETURNING expression
        if (returningExpression &&
            (DriverUtils_1.DriverUtils.isPostgresFamily(this.connection.driver) ||
                this.connection.driver.options.type === "oracle" ||
                this.connection.driver.options.type === "cockroachdb" ||
                DriverUtils_1.DriverUtils.isMySQLFamily(this.connection.driver))) {
            query += ` RETURNING ${returningExpression}`;
        }
        // Inserting a specific value for an auto-increment primary key in mssql requires enabling IDENTITY_INSERT
        // IDENTITY_INSERT can only be enabled for tables where there is an IDENTITY column and only if there is a value to be inserted (i.e. supplying DEFAULT is prohibited if IDENTITY_INSERT is enabled)
        if (this.connection.driver.options.type === "mssql" &&
            this.expressionMap.mainAlias.hasMetadata &&
            this.expressionMap
                .mainAlias.metadata.columns.filter((column) => this.expressionMap.insertColumns.length > 0
                ? this.expressionMap.insertColumns.indexOf(column.propertyPath) !== -1
                : column.isInsert)
                .some((column) => this.isOverridingAutoIncrementBehavior(column))) {
            query = `SET IDENTITY_INSERT ${tableName} ON; ${query}; SET IDENTITY_INSERT ${tableName} OFF`;
        }
        return query;
    }
    /**
     * Gets list of columns where values must be inserted to.
     */
    getInsertedColumns() {
        if (!this.expressionMap.mainAlias.hasMetadata)
            return [];
        return this.expressionMap.mainAlias.metadata.columns.filter((column) => {
            // if user specified list of columns he wants to insert to, then we filter only them
            if (this.expressionMap.insertColumns.length)
                return (this.expressionMap.insertColumns.indexOf(column.propertyPath) !== -1);
            // skip columns the user doesn't want included by default
            if (!column.isInsert) {
                return false;
            }
            // if user did not specified such list then return all columns except auto-increment one
            // for Oracle we return auto-increment column as well because Oracle does not support DEFAULT VALUES expression
            if (column.isGenerated &&
                column.generationStrategy === "increment" &&
                !(this.connection.driver.options.type === "spanner") &&
                !(this.connection.driver.options.type === "oracle") &&
                !DriverUtils_1.DriverUtils.isSQLiteFamily(this.connection.driver) &&
                !DriverUtils_1.DriverUtils.isMySQLFamily(this.connection.driver) &&
                !(this.connection.driver.options.type === "aurora-mysql") &&
                !(this.connection.driver.options.type === "mssql" &&
                    this.isOverridingAutoIncrementBehavior(column)))
                return false;
            return true;
        });
    }
    /**
     * Creates a columns string where values must be inserted to for INSERT INTO expression.
     */
    createColumnNamesExpression() {
        const columns = this.getInsertedColumns();
        if (columns.length > 0)
            return columns
                .map((column) => this.escape(column.databaseName))
                .join(", ");
        // in the case if there are no insert columns specified and table without metadata used
        // we get columns from the inserted value map, in the case if only one inserted map is specified
        if (!this.expressionMap.mainAlias.hasMetadata &&
            !this.expressionMap.insertColumns.length) {
            const valueSets = this.getValueSets();
            if (valueSets.length === 1)
                return Object.keys(valueSets[0])
                    .map((columnName) => this.escape(columnName))
                    .join(", ");
        }
        // get a table name and all column database names
        return this.expressionMap.insertColumns
            .map((columnName) => this.escape(columnName))
            .join(", ");
    }
    /**
     * Creates list of values needs to be inserted in the VALUES expression.
     */
    createValuesExpression() {
        const valueSets = this.getValueSets();
        const columns = this.getInsertedColumns();
        // if column metadatas are given then apply all necessary operations with values
        if (columns.length > 0) {
            let expression = "";
            valueSets.forEach((valueSet, valueSetIndex) => {
                columns.forEach((column, columnIndex) => {
                    if (columnIndex === 0) {
                        if (this.connection.driver.options.type === "oracle" &&
                            valueSets.length > 1) {
                            expression += " SELECT ";
                        }
                        else if (this.connection.driver.options.type === "sap" &&
                            valueSets.length > 1) {
                            expression += " SELECT ";
                        }
                        else {
                            expression += "(";
                        }
                    }
                    // extract real value from the entity
                    let value = column.getEntityValue(valueSet);
                    // if column is relational and value is an object then get real referenced column value from this object
                    // for example column value is { question: { id: 1 } }, value will be equal to { id: 1 }
                    // and we extract "1" from this object
                    /*if (column.referencedColumn && value instanceof Object && !(typeof value === "function")) { // todo: check if we still need it since getEntityValue already has similar code
                        value = column.referencedColumn.getEntityValue(value);
                    }*/
                    if (!(typeof value === "function")) {
                        // make sure our value is normalized by a driver
                        value = this.connection.driver.preparePersistentValue(value, column);
                    }
                    // newly inserted entities always have a version equal to 1 (first version)
                    // also, user-specified version must be empty
                    if (column.isVersion && value === undefined) {
                        expression += "1";
                        // } else if (column.isNestedSetLeft) {
                        //     const tableName = this.connection.driver.escape(column.entityMetadata.tablePath);
                        //     const rightColumnName = this.connection.driver.escape(column.entityMetadata.nestedSetRightColumn!.databaseName);
                        //     const subQuery = `(SELECT c.max + 1 FROM (SELECT MAX(${rightColumnName}) as max from ${tableName}) c)`;
                        //     expression += subQuery;
                        //
                        // } else if (column.isNestedSetRight) {
                        //     const tableName = this.connection.driver.escape(column.entityMetadata.tablePath);
                        //     const rightColumnName = this.connection.driver.escape(column.entityMetadata.nestedSetRightColumn!.databaseName);
                        //     const subQuery = `(SELECT c.max + 2 FROM (SELECT MAX(${rightColumnName}) as max from ${tableName}) c)`;
                        //     expression += subQuery;
                    }
                    else if (column.isDiscriminator) {
                        expression += this.createParameter(this.expressionMap.mainAlias.metadata
                            .discriminatorValue);
                        // return "1";
                        // for create and update dates we insert current date
                        // no, we don't do it because this constant is already in "default" value of the column
                        // with extended timestamp functionality, like CURRENT_TIMESTAMP(6) for example
                        // } else if (column.isCreateDate || column.isUpdateDate) {
                        //     return "CURRENT_TIMESTAMP";
                        // if column is generated uuid and database does not support its generation and custom generated value was not provided by a user - we generate a new uuid value for insertion
                    }
                    else if (column.isGenerated &&
                        column.generationStrategy === "uuid" &&
                        !this.connection.driver.isUUIDGenerationSupported() &&
                        value === undefined) {
                        value = (0, uuid_1.v4)();
                        expression += this.createParameter(value);
                        if (!(valueSetIndex in
                            this.expressionMap.locallyGenerated)) {
                            this.expressionMap.locallyGenerated[valueSetIndex] =
                                {};
                        }
                        column.setEntityValue(this.expressionMap.locallyGenerated[valueSetIndex], value);
                        // if value for this column was not provided then insert default value
                    }
                    else if (value === undefined) {
                        if ((this.connection.driver.options.type === "oracle" &&
                            valueSets.length > 1) ||
                            DriverUtils_1.DriverUtils.isSQLiteFamily(this.connection.driver) ||
                            this.connection.driver.options.type === "sap" ||
                            this.connection.driver.options.type === "spanner") {
                            // unfortunately sqlite does not support DEFAULT expression in INSERT queries
                            if (column.default !== undefined &&
                                column.default !== null) {
                                // try to use default defined in the column
                                expression +=
                                    this.connection.driver.normalizeDefault(column);
                            }
                            else {
                                expression += "NULL"; // otherwise simply use NULL and pray if column is nullable
                            }
                        }
                        else {
                            expression += "DEFAULT";
                        }
                    }
                    else if (value === null &&
                        this.connection.driver.options.type === "spanner") {
                        expression += "NULL";
                        // support for SQL expressions in queries
                    }
                    else if (typeof value === "function") {
                        expression += value();
                        // just any other regular value
                    }
                    else {
                        if (this.connection.driver.options.type === "mssql")
                            value = this.connection.driver.parametrizeValue(column, value);
                        // we need to store array values in a special class to make sure parameter replacement will work correctly
                        // if (value instanceof Array)
                        //     value = new ArrayParameter(value);
                        const paramName = this.createParameter(value);
                        if ((DriverUtils_1.DriverUtils.isMySQLFamily(this.connection.driver) ||
                            this.connection.driver.options.type ===
                                "aurora-mysql") &&
                            this.connection.driver.spatialTypes.indexOf(column.type) !== -1) {
                            const useLegacy = this.connection.driver.options.legacySpatialSupport;
                            const geomFromText = useLegacy
                                ? "GeomFromText"
                                : "ST_GeomFromText";
                            if (column.srid != null) {
                                expression += `${geomFromText}(${paramName}, ${column.srid})`;
                            }
                            else {
                                expression += `${geomFromText}(${paramName})`;
                            }
                        }
                        else if (DriverUtils_1.DriverUtils.isPostgresFamily(this.connection.driver) &&
                            this.connection.driver.spatialTypes.indexOf(column.type) !== -1) {
                            if (column.srid != null) {
                                expression += `ST_SetSRID(ST_GeomFromGeoJSON(${paramName}), ${column.srid})::${column.type}`;
                            }
                            else {
                                expression += `ST_GeomFromGeoJSON(${paramName})::${column.type}`;
                            }
                        }
                        else if (this.connection.driver.options.type === "mssql" &&
                            this.connection.driver.spatialTypes.indexOf(column.type) !== -1) {
                            expression +=
                                column.type +
                                    "::STGeomFromText(" +
                                    paramName +
                                    ", " +
                                    (column.srid || "0") +
                                    ")";
                        }
                        else {
                            expression += paramName;
                        }
                    }
                    if (columnIndex === columns.length - 1) {
                        if (valueSetIndex === valueSets.length - 1) {
                            if (this.connection.driver.options.type ===
                                "oracle" &&
                                valueSets.length > 1) {
                                expression += " FROM DUAL ";
                            }
                            else if (this.connection.driver.options.type === "sap" &&
                                valueSets.length > 1) {
                                expression += " FROM dummy ";
                            }
                            else {
                                expression += ")";
                            }
                        }
                        else {
                            if (this.connection.driver.options.type ===
                                "oracle" &&
                                valueSets.length > 1) {
                                expression += " FROM DUAL UNION ALL ";
                            }
                            else if (this.connection.driver.options.type === "sap" &&
                                valueSets.length > 1) {
                                expression += " FROM dummy UNION ALL ";
                            }
                            else {
                                expression += "), ";
                            }
                        }
                    }
                    else {
                        expression += ", ";
                    }
                });
            });
            if (expression === "()")
                return "";
            return expression;
        }
        else {
            // for tables without metadata
            // get values needs to be inserted
            let expression = "";
            valueSets.forEach((valueSet, insertionIndex) => {
                const columns = Object.keys(valueSet);
                columns.forEach((columnName, columnIndex) => {
                    if (columnIndex === 0) {
                        expression += "(";
                    }
                    const value = valueSet[columnName];
                    // support for SQL expressions in queries
                    if (typeof value === "function") {
                        expression += value();
                        // if value for this column was not provided then insert default value
                    }
                    else if (value === undefined) {
                        if ((this.connection.driver.options.type === "oracle" &&
                            valueSets.length > 1) ||
                            DriverUtils_1.DriverUtils.isSQLiteFamily(this.connection.driver) ||
                            this.connection.driver.options.type === "sap" ||
                            this.connection.driver.options.type === "spanner") {
                            expression += "NULL";
                        }
                        else {
                            expression += "DEFAULT";
                        }
                    }
                    else if (value === null &&
                        this.connection.driver.options.type === "spanner") {
                        // just any other regular value
                    }
                    else {
                        expression += this.createParameter(value);
                    }
                    if (columnIndex === Object.keys(valueSet).length - 1) {
                        if (insertionIndex === valueSets.length - 1) {
                            expression += ")";
                        }
                        else {
                            expression += "), ";
                        }
                    }
                    else {
                        expression += ", ";
                    }
                });
            });
            if (expression === "()")
                return "";
            return expression;
        }
    }
    /**
     * Gets array of values need to be inserted into the target table.
     */
    getValueSets() {
        if (Array.isArray(this.expressionMap.valuesSet))
            return this.expressionMap.valuesSet;
        if (ObjectUtils_1.ObjectUtils.isObject(this.expressionMap.valuesSet))
            return [this.expressionMap.valuesSet];
        throw new InsertValuesMissingError_1.InsertValuesMissingError();
    }
    /**
     * Checks if column is an auto-generated primary key, but the current insertion specifies a value for it.
     *
     * @param column
     */
    isOverridingAutoIncrementBehavior(column) {
        return (column.isPrimary &&
            column.isGenerated &&
            column.generationStrategy === "increment" &&
            this.getValueSets().some((valueSet) => column.getEntityValue(valueSet) !== undefined &&
                column.getEntityValue(valueSet) !== null));
    }
}
exports.InsertQueryBuilder = InsertQueryBuilder;

//# sourceMappingURL=InsertQueryBuilder.js.map
