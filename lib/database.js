const mysql = require('mysql2/promise');

/**
 * Database Connection Manager
 * Handles connections for both free and enterprise users
 */
class DatabaseManager {
  constructor() {
    this.mainDbPool = null;
    this.tenantDbPools = new Map();
  }

  /**
   * Initialize main database connection pool
   */
  async initializeMainDb() {
    if (this.mainDbPool) {
      return this.mainDbPool;
    }

    this.mainDbPool = mysql.createPool({
      host: process.env.MAIN_DB_HOST,
      user: process.env.MAIN_DB_USER,
      password: process.env.MAIN_DB_PASSWORD,
      database: process.env.MAIN_DB_NAME || 'mycroshop_main',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    return this.mainDbPool;
  }

  /**
   * Get tenant information from main database
   * @param {number} tenantId - Tenant ID
   * @returns {Promise<Object>} Tenant information
   */
  async getTenantInfo(tenantId) {
    const pool = await this.initializeMainDb();
    
    const [rows] = await pool.execute(
      'SELECT id, name, subscription_plan, db_name FROM tenants WHERE id = ?',
      [tenantId]
    );

    if (rows.length === 0) {
      throw new Error(`Tenant ${tenantId} not found`);
    }

    return rows[0];
  }

  /**
   * Get tenant database connection
   * @param {number} tenantId - Tenant ID
   * @param {string} subscriptionPlan - 'free' or 'enterprise'
   * @returns {Promise<mysql.Pool>} Database connection pool
   */
  async getTenantDb(tenantId, subscriptionPlan) {
    // Free users use shared database
    if (subscriptionPlan === 'free') {
      return this.getSharedFreeDb();
    }

    // Enterprise users have separate databases
    if (this.tenantDbPools.has(tenantId)) {
      return this.tenantDbPools.get(tenantId);
    }

    const dbName = `${process.env.TENANT_DB_PREFIX || 'mycroshop_tenant_'}${tenantId}`;
    
    const pool = mysql.createPool({
      host: process.env.TENANT_DB_HOST,
      user: process.env.TENANT_DB_USER,
      password: process.env.TENANT_DB_PASSWORD,
      database: dbName,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    this.tenantDbPools.set(tenantId, pool);
    return pool;
  }

  /**
   * Get shared free database connection
   * @returns {Promise<mysql.Pool>} Shared database pool
   */
  async getSharedFreeDb() {
    if (this.sharedFreeDbPool) {
      return this.sharedFreeDbPool;
    }

    const dbName = process.env.SHARED_FREE_DB_NAME || 'mycroshop_free_shared';
    
    this.sharedFreeDbPool = mysql.createPool({
      host: process.env.TENANT_DB_HOST,
      user: process.env.TENANT_DB_USER,
      password: process.env.TENANT_DB_PASSWORD,
      database: dbName,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    return this.sharedFreeDbPool;
  }

  /**
   * Query products for free user (online store only)
   * @param {number} tenantId - Tenant ID
   * @param {Object} filters - Search filters
   * @returns {Promise<Array>} Products
   */
  async getFreeUserProducts(tenantId, filters = {}) {
    const db = await this.getSharedFreeDb();
    
    let query = `
      SELECT 
        osp.id,
        osp.product_id,
        p.name,
        p.description,
        p.price,
        p.category,
        osp.stock,
        osp.is_published,
        os.store_name
      FROM online_store_products osp
      JOIN products p ON osp.product_id = p.id
      JOIN online_stores os ON osp.online_store_id = os.id
      WHERE osp.tenant_id = ?
        AND osp.is_published = true
        AND osp.stock > 0
    `;

    const params = [tenantId];

    if (filters.name) {
      query += ` AND p.name LIKE ?`;
      params.push(`%${filters.name}%`);
    }

    if (filters.category) {
      query += ` AND p.category = ?`;
      params.push(filters.category);
    }

    query += ` ORDER BY p.name LIMIT 50`;

    const [rows] = await db.execute(query, params);
    return rows;
  }

  /**
   * Query products for enterprise user (all physical stores)
   * @param {number} tenantId - Tenant ID
   * @param {Object} filters - Search filters
   * @returns {Promise<Array>} Products
   */
  async getEnterpriseUserProducts(tenantId, filters = {}) {
    const db = await this.getTenantDb(tenantId, 'enterprise');
    
    let query = `
      SELECT 
        p.id,
        p.name,
        p.description,
        p.price,
        p.category,
        ps.stock,
        s.name as store_name,
        s.id as store_id
      FROM products p
      JOIN product_stores ps ON p.id = ps.product_id
      JOIN stores s ON ps.store_id = s.id
      WHERE p.is_active = true
        AND ps.stock > 0
    `;

    const params = [];

    if (filters.name) {
      query += ` AND p.name LIKE ?`;
      params.push(`%${filters.name}%`);
    }

    if (filters.category) {
      query += ` AND p.category = ?`;
      params.push(filters.category);
    }

    if (filters.store_id) {
      query += ` AND s.id = ?`;
      params.push(filters.store_id);
    }

    query += ` ORDER BY p.name LIMIT 50`;

    const [rows] = await db.execute(query, params);
    return rows;
  }

  /**
   * Get products based on tenant type
   * @param {number} tenantId - Tenant ID
   * @param {string} subscriptionPlan - 'free' or 'enterprise'
   * @param {Object} filters - Search filters
   * @returns {Promise<Array>} Products
   */
  async getProducts(tenantId, subscriptionPlan, filters = {}) {
    if (subscriptionPlan === 'free') {
      return this.getFreeUserProducts(tenantId, filters);
    } else {
      return this.getEnterpriseUserProducts(tenantId, filters);
    }
  }

  /**
   * Update product stock
   * @param {number} tenantId - Tenant ID
   * @param {string} subscriptionPlan - 'free' or 'enterprise'
   * @param {number} productId - Product ID
   * @param {number} quantity - Quantity to deduct
   * @returns {Promise<boolean>} Success status
   */
  async updateStock(tenantId, subscriptionPlan, productId, quantity) {
    try {
      if (subscriptionPlan === 'free') {
        const db = await this.getSharedFreeDb();
        await db.execute(
          `UPDATE online_store_products 
           SET stock = stock - ? 
           WHERE tenant_id = ? AND product_id = ? AND stock >= ?`,
          [quantity, tenantId, productId, quantity]
        );
      } else {
        const db = await this.getTenantDb(tenantId, 'enterprise');
        // Update all stores that have this product
        await db.execute(
          `UPDATE product_stores 
           SET stock = stock - ? 
           WHERE product_id = ? AND stock >= ?`,
          [quantity, productId, quantity]
        );
      }
      return true;
    } catch (error) {
      console.error('Error updating stock:', error);
      return false;
    }
  }
}

module.exports = new DatabaseManager();

