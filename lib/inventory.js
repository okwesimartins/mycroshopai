const axios = require('axios');
const database = require('./database');

/**
 * Inventory Management
 * Handles product queries and stock updates
 */
class InventoryManager {
  constructor() {
    this.apiUrl = process.env.MYCROSHOP_API_URL || 'https://backend.mycroshop.com';
    this.apiKey = process.env.MYCROSHOP_API_KEY;
  }

  /**
   * Query products by name or filters
   * @param {number} tenantId - Tenant ID
   * @param {string} subscriptionPlan - 'free' or 'enterprise'
   * @param {Object} filters - Search filters
   * @returns {Promise<Array>} Products
   */
  async queryProducts(tenantId, subscriptionPlan, filters = {}) {
    try {
      // Option 1: Use direct database access (faster)
      if (process.env.USE_DIRECT_DB === 'true') {
        return await database.getProducts(tenantId, subscriptionPlan, filters);
      }

      // Option 2: Use MycroShop API
      const params = new URLSearchParams({
        tenant_id: tenantId.toString(),
        ...filters
      });

      const response = await axios.get(
        `${this.apiUrl}/api/v1/store/products?${params}`,
        {
          headers: {
            'x-api-key': this.apiKey,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data.success) {
        return response.data.data.products || [];
      }

      return [];
    } catch (error) {
      console.error('Error querying products:', error);
      // Fallback to direct DB
      return await database.getProducts(tenantId, subscriptionPlan, filters);
    }
  }

  /**
   * Get product by ID
   * @param {number} tenantId - Tenant ID
   * @param {string} subscriptionPlan - 'free' or 'enterprise'
   * @param {number} productId - Product ID
   * @returns {Promise<Object|null>} Product
   */
  async getProductById(tenantId, subscriptionPlan, productId) {
    try {
      const products = await this.queryProducts(tenantId, subscriptionPlan, {});
      return products.find(p => p.id === productId || p.product_id === productId) || null;
    } catch (error) {
      console.error('Error getting product:', error);
      return null;
    }
  }

  /**
   * Check if product is available
   * @param {number} tenantId - Tenant ID
   * @param {string} subscriptionPlan - 'free' or 'enterprise'
   * @param {string} productName - Product name
   * @param {number} quantity - Required quantity
   * @returns {Promise<Object>} Availability info
   */
  async checkAvailability(tenantId, subscriptionPlan, productName, quantity = 1) {
    try {
      const products = await this.queryProducts(tenantId, subscriptionPlan, {
        name: productName
      });

      if (products.length === 0) {
        return {
          available: false,
          message: `Sorry, "${productName}" is not available.`
        };
      }

      // Find exact match or closest match
      const product = products.find(p => 
        p.name.toLowerCase() === productName.toLowerCase()
      ) || products[0];

      const stock = product.stock || product.stock || 0;

      if (stock >= quantity) {
        return {
          available: true,
          product: product,
          stock: stock,
          message: `Yes! "${product.name}" is available. We have ${stock} in stock.`
        };
      } else {
        return {
          available: false,
          product: product,
          stock: stock,
          message: `"${product.name}" is available but we only have ${stock} in stock. You requested ${quantity}.`
        };
      }
    } catch (error) {
      console.error('Error checking availability:', error);
      return {
        available: false,
        message: 'Sorry, I encountered an error checking availability. Please try again.'
      };
    }
  }

  /**
   * Update product stock after order
   * @param {number} tenantId - Tenant ID
   * @param {string} subscriptionPlan - 'free' or 'enterprise'
   * @param {number} productId - Product ID
   * @param {number} quantity - Quantity to deduct
   * @returns {Promise<boolean>} Success status
   */
  async updateStock(tenantId, subscriptionPlan, productId, quantity) {
    try {
      // Option 1: Direct database update (faster)
      if (process.env.USE_DIRECT_DB === 'true') {
        return await database.updateStock(tenantId, subscriptionPlan, productId, quantity);
      }

      // Option 2: Use MycroShop API
      const response = await axios.put(
        `${this.apiUrl}/api/v1/inventory/products/${productId}/stock`,
        {
          tenant_id: tenantId,
          quantity: -quantity, // Negative to deduct
          reason: 'order_fulfillment'
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return response.data.success === true;
    } catch (error) {
      console.error('Error updating stock:', error);
      // Fallback to direct DB
      return await database.updateStock(tenantId, subscriptionPlan, productId, quantity);
    }
  }

  /**
   * Format product list for AI response
   * @param {Array} products - Products array
   * @param {string} subscriptionPlan - 'free' or 'enterprise'
   * @returns {string} Formatted text
   */
  formatProductList(products, subscriptionPlan) {
    if (products.length === 0) {
      return 'Sorry, no products found matching your search.';
    }

    let text = `Here are the available products:\n\n`;
    
    products.slice(0, 10).forEach((product, index) => {
      const name = product.name || product.product_name;
      const price = product.price ? `₦${parseFloat(product.price).toLocaleString()}` : 'Price on request';
      const stock = product.stock || 0;
      const store = subscriptionPlan === 'enterprise' && product.store_name 
        ? ` (${product.store_name})` 
        : '';

      text += `${index + 1}. ${name} - ${price}\n`;
      text += `   Stock: ${stock}${store}\n\n`;
    });

    if (products.length > 10) {
      text += `... and ${products.length - 10} more products.`;
    }

    return text;
  }
}

module.exports = new InventoryManager();

