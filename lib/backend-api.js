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
    const status = err.response?.status;
    const data = err.response?.data;
    console.error('[BackendAPI] resolveTenant failed:', status, data?.message || err.message, 'phone_number_id:', phoneNumberId);
    if (data && typeof data === 'object') {
      console.error('[BackendAPI] resolveTenant response:', JSON.stringify(data).substring(0, 400));
    }
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
    const status = err.response?.status;
    const body   = err.response?.data;
    // Log full detail so we can diagnose plan/endpoint issues
    console.error(`[BackendAPI] checkProduct error: HTTP ${status || 'no-response'} | product="${productName}" | plan="${subscriptionPlan}"`, body || err.message);
    // Return a structured error so callers can distinguish server-error from product-not-found
    return { success: false, exists: false, _serverError: true, status };
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
      items: (orderData.items || []).map(item => {
        const entry = {
          product_id: item.product_id,
          quantity:   item.quantity,
          unit_price: item.price,
        };
        if (item.variant_id) entry.variant_id = item.variant_id;
        return entry;
      }),
      customer_name:    orderData.customer_info?.name     || 'WhatsApp Customer',
      customer_email:   orderData.customer_info?.email    || '',
      customer_phone:   orderData.customer_info?.phone    || '',
      customer_address: orderData.customer_info?.shipping_address || '',
      notes: 'Order created via WhatsApp AI Assistant'
    };

    console.log('[BackendAPI] createOrder payload:', JSON.stringify(payload));
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
    const status  = err.response?.status;
    const body    = err.response?.data;
    const msg     = body?.message || body?.error || err.message;
    console.error(`[BackendAPI] createOrder error: HTTP ${status || 'no-response'} | ${msg}`);
    if (body) console.error('[BackendAPI] createOrder response body:', JSON.stringify(body).substring(0, 500));
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



/**
 * Get the latest pending order for a customer phone number
 */
async function getPendingOrderByPhone(tenantId, customerPhone) {
  if (!API_KEY) return null;
  try {
    const res = await axios.get(`${BASE_URL}/api/v1/ai-agent/orders/pending-by-phone`, {
      params: { tenant_id: tenantId, customer_phone: customerPhone },
      headers: headers(),
      timeout: 10000,
    });
    if (res.data?.success && res.data?.data?.order) return res.data.data.order;
    return null;
  } catch (err) {
    console.error('[BackendAPI] getPendingOrderByPhone error:', err.response?.data || err.message);
    return null;
  }
}

/**
 * Attach a payment receipt to an order
 * @param {number} tenantId
 * @param {number} orderId
 * @param {Object} receipt - { receipt_image_base64, mime_type } or { receipt_url }
 */
async function attachOrderReceipt(tenantId, orderId, receipt) {
  if (!API_KEY) return null;
  try {
    const payload = { tenant_id: tenantId, order_id: orderId, ...receipt };
    const res = await axios.post(
      `${BASE_URL}/api/v1/ai-agent/attach-order-receipt`,
      payload,
      { headers: headers(), timeout: 20000 }
    );
    return res.data?.success ? res.data : null;
  } catch (err) {
    console.error('[BackendAPI] attachOrderReceipt error:', err.response?.data || err.message);
    return null;
  }
}

/**
 * Confirm or decline an order payment (called after store owner approves/declines)
 * @param {number} tenantId
 * @param {number} orderId
 * @param {'approve'|'decline'} action
 */
async function confirmOrderPayment(tenantId, orderId, action) {
  if (!API_KEY) throw new Error('AI_AGENT_API_KEY not set');
  try {
    const res = await axios.post(
      `${BASE_URL}/api/v1/ai-agent/confirm-order-payment`,
      { tenant_id: tenantId, order_id: orderId, action },
      { headers: headers(), timeout: 15000 }
    );
    if (res.data?.success) return { success: true, order: res.data.data?.order };
    throw new Error(res.data?.message || 'Confirmation failed');
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.error('[BackendAPI] confirmOrderPayment error:', msg);
    throw new Error(`Failed to confirm order: ${msg}`);
  }
}

/**
 * Record the link between the WhatsApp order-confirmation message we sent
 * and the order it belongs to.
 * Called right after we send the "Order placed — send receipt" message.
 * Lets us resolve which order a receipt belongs to when customer replies to that message.
 *
 * @param {number} tenantId
 * @param {number} orderId
 * @param {string} confirmationMessageId  — WhatsApp wamid of the message we sent
 */
async function recordConfirmationMessage(tenantId, orderId, confirmationMessageId) {
  if (!API_KEY || !confirmationMessageId) return null;
  try {
    const res = await axios.post(
      `${BASE_URL}/api/v1/ai-agent/orders/record-confirmation-message`,
      { tenant_id: tenantId, order_id: orderId, confirmation_message_id: confirmationMessageId },
      { headers: headers(), timeout: 10000 }
    );
    return res.data?.success ? res.data : null;
  } catch (err) {
    console.error('[BackendAPI] recordConfirmationMessage error:', err.response?.data || err.message);
    return null; // non-fatal — order flow continues even if this fails
  }
}

/**
 * Given the WhatsApp message ID of an order confirmation we previously sent,
 * return the order_id it belongs to.
 * Used when a customer replies to a specific confirmation message with their receipt —
 * lets us attach the receipt to exactly the right order even with multiple pending orders.
 *
 * @param {number} tenantId
 * @param {string} confirmationMessageId  — the quotedMessageId from the incoming receipt
 * @returns {Promise<number|null>}  order_id, or null if not found
 */
async function getOrderByConfirmationMessage(tenantId, confirmationMessageId) {
  if (!API_KEY || !confirmationMessageId) return null;
  try {
    const res = await axios.get(
      `${BASE_URL}/api/v1/ai-agent/orders/by-confirmation-message`,
      { params: { tenant_id: tenantId, confirmation_message_id: confirmationMessageId }, headers: headers(), timeout: 10000 }
    );
    return res.data?.data?.order_id ?? null;
  } catch (err) {
    console.error('[BackendAPI] getOrderByConfirmationMessage error:', err.response?.data || err.message);
    return null;
  }
}

module.exports = {
  resolveTenant,
  checkProduct,
  listProducts,
  getProductInfo,
  createOrder,
  verifyPayment,
  getPendingOrderByPhone,
  attachOrderReceipt,
  confirmOrderPayment,
  recordConfirmationMessage,
  getOrderByConfirmationMessage,
};
