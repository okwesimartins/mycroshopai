/**
 * Backend API client for Google Cloud AI agent
 * All tenant data, inventory, orders, payments go through the backend (no direct DB from Cloud)
 */
const axios = require('axios');

const BASE_URL = (process.env.BACKEND_BASE_URL || process.env.MYCROSHOP_API_URL || 'https://backend.mycroshop.com').replace(/\/$/, '');
const API_KEY = process.env.AI_AGENT_API_KEY || process.env.MYCROSHOP_API_KEY;

function headers() {
  return {
    'x-api-key': API_KEY,
    'Content-Type': 'application/json'
  };
}

/**
 * Resolve tenant and WhatsApp token from phone_number_id
 * @returns {Promise<{ tenant_id, access_token, store_name, subscription_plan }|null>}
 */
async function resolveTenant(phoneNumberId) {
  if (!API_KEY) {
    console.error('[BackendAPI] AI_AGENT_API_KEY not set');
    return null;
  }
  try {
    const res = await axios.get(`${BASE_URL}/api/v1/ai-agent/resolve-tenant`, {
      params: { phone_number_id: phoneNumberId },
      headers: headers(),
      timeout: 15000
    });
    if (res.data?.success && res.data?.data) {
      return res.data.data;
    }
    return null;
  } catch (err) {
    console.error('[BackendAPI] resolveTenant error:', err.response?.data || err.message);
    return null;
  }
}

/**
 * Check product availability by name
 * @returns {Promise<{ exists, product?, message }|null>}
 */
async function checkProduct(tenantId, productName, subscriptionPlan = 'enterprise') {
  if (!API_KEY) return null;
  try {
    const res = await axios.get(`${BASE_URL}/api/v1/ai-agent/check-product`, {
      params: { tenant_id: tenantId, name: productName, subscription_plan: subscriptionPlan },
      headers: headers(),
      timeout: 10000
    });
    if (res.data?.success !== undefined) {
      return res.data;
    }
    return null;
  } catch (err) {
    console.error('[BackendAPI] checkProduct error:', err.response?.data || err.message);
    return null;
  }
}

/**
 * List products (inventory/catalog) for AI – optional search, returns image_url for sharing media
 * @returns {Promise<{ products: Array<{ id, name, price, stock, category, image_url, description? }> }|null>}
 */
async function listProducts(tenantId, subscriptionPlan = 'enterprise', options = {}) {
  if (!API_KEY) return null;
  try {
    const params = { tenant_id: tenantId, subscription_plan: subscriptionPlan };
    if (options.search) params.search = options.search;
    if (options.limit) params.limit = options.limit;
    const res = await axios.get(`${BASE_URL}/api/v1/ai-agent/list-products`, {
      params,
      headers: headers(),
      timeout: 10000
    });
    if (res.data?.success && Array.isArray(res.data.products)) {
      return { products: res.data.products };
    }
    return null;
  } catch (err) {
    console.error('[BackendAPI] listProducts error:', err.response?.data || err.message);
    return null;
  }
}

/**
 * Get product info by ID
 */
async function getProductInfo(tenantId, productId, subscriptionPlan = 'enterprise') {
  if (!API_KEY) return null;
  try {
    const res = await axios.get(`${BASE_URL}/api/v1/ai-agent/product-info`, {
      params: { tenant_id: tenantId, product_id: productId, subscription_plan: subscriptionPlan },
      headers: headers(),
      timeout: 10000
    });
    if (res.data?.success && res.data?.product) {
      return res.data.product;
    }
    return null;
  } catch (err) {
    console.error('[BackendAPI] getProductInfo error:', err.response?.data || err.message);
    return null;
  }
}

/**
 * Create order via backend (online store order)
 * @param {number} tenantId
 * @param {Object} orderData - { online_store_id, items: [{ product_id, product_name, quantity, price }], customer_info: { name, email, phone, shipping_address } }
 */
async function createOrder(tenantId, orderData) {
  if (!API_KEY) {
    throw new Error('AI_AGENT_API_KEY not set');
  }
  const online_store_id = orderData.online_store_id || null;
  if (!online_store_id) {
    throw new Error('online_store_id is required to create order');
  }
  try {
    const payload = {
      tenant_id: tenantId,
      online_store_id,
      items: (orderData.items || []).map(item => ({
        product_id: item.product_id,
        quantity: item.quantity,
        unit_price: item.price
      })),
      customer_name: orderData.customer_info?.name || 'WhatsApp Customer',
      customer_email: orderData.customer_info?.email || '',
      customer_phone: orderData.customer_info?.phone || '',
      customer_address: orderData.customer_info?.shipping_address || '',
      notes: 'Order created via WhatsApp AI Assistant'
    };
    const res = await axios.post(
      `${BASE_URL}/api/v1/online-store-orders`,
      payload,
      { headers: headers(), timeout: 15000 }
    );
    if (res.data?.success && res.data?.data) {
      return {
        success: true,
        order: res.data.data.order || res.data.data,
        paymentLink: res.data.data.payment_link || res.data.data.payment_link
      };
    }
    throw new Error(res.data?.message || 'Failed to create order');
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.error('[BackendAPI] createOrder error:', msg);
    throw new Error(`Failed to create order: ${msg}`);
  }
}

/**
 * Verify payment by reference
 */
async function verifyPayment(tenantId, reference) {
  if (!API_KEY) {
    return { success: false, paid: false, message: 'API key not set' };
  }
  try {
    const res = await axios.get(`${BASE_URL}/api/v1/payments/verify`, {
      params: { reference, tenant_id: tenantId },
      headers: headers(),
      timeout: 10000
    });
    if (res.data?.success && res.data?.data) {
      const transaction = res.data.data.transaction;
      return {
        success: true,
        paid: transaction?.status === 'success',
        transaction,
        order: res.data.data.order
      };
    }
    return { success: false, paid: false, message: res.data?.message || 'Verification failed' };
  } catch (err) {
    console.error('[BackendAPI] verifyPayment error:', err.response?.data || err.message);
    return { success: false, paid: false, message: 'Failed to verify payment' };
  }
}

module.exports = {
  resolveTenant,
  checkProduct,
  listProducts,
  getProductInfo,
  createOrder,
  verifyPayment
};
