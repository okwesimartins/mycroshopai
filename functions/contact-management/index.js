const functions = require('@google-cloud/functions-framework');
const firestore = require('../../lib/firestore');
const contactPricing = require('../../lib/contact-pricing');

/**
 * Contact Management API
 * Handles contact count queries, limit management, and tier upgrades
 */
functions.http('contactManagement', async (req, res) => {
  try {
    // CORS headers
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      return res.status(204).send('');
    }

    const { tenantId } = req.query;
    const { action } = req.body || {};

    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'tenant_id is required'
      });
    }

    switch (action || req.method) {
      case 'GET':
      case 'get_count':
        return await handleGetContactCount(req, res, tenantId);

      case 'get_limit':
        return await handleGetContactLimit(req, res, tenantId);

      case 'set_limit':
        return await handleSetContactLimit(req, res, tenantId);

      case 'get_contacts':
        return await handleGetContacts(req, res, tenantId);

      case 'get_tiers':
        return await handleGetTiers(req, res);

      case 'get_recommended_tier':
        return await handleGetRecommendedTier(req, res, tenantId);

      default:
        return res.status(400).json({
          success: false,
          message: 'Invalid action'
        });
    }
  } catch (error) {
    console.error('Contact management error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

/**
 * Get contact count for tenant
 */
async function handleGetContactCount(req, res, tenantId) {
  try {
    const contactLimit = await firestore.checkContactLimit(tenantId);

    return res.status(200).json({
      success: true,
      data: {
        count: contactLimit.count,
        limit: contactLimit.limit,
        remaining: contactLimit.remaining,
        reached: contactLimit.reached,
        usagePercent: ((contactLimit.count / contactLimit.limit) * 100).toFixed(2)
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to get contact count',
      error: error.message
    });
  }
}

/**
 * Get contact limit for tenant
 */
async function handleGetContactLimit(req, res, tenantId) {
  try {
    const limit = await firestore.getContactLimit(tenantId);
    const tier = contactPricing.getTierByLimit(limit);

    return res.status(200).json({
      success: true,
      data: {
        limit,
        tier: tier ? {
          id: tier.id,
          name: tier.name,
          price: tier.price,
          formattedPrice: contactPricing.formatPrice(tier)
        } : null
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to get contact limit',
      error: error.message
    });
  }
}

/**
 * Set contact limit for tenant (upgrade/downgrade tier)
 */
async function handleSetContactLimit(req, res, tenantId) {
  try {
    const { limit, tierId } = req.body;

    if (!limit && !tierId) {
      return res.status(400).json({
        success: false,
        message: 'limit or tierId is required'
      });
    }

    let finalLimit = limit;

    if (tierId) {
      const tier = contactPricing.getTier(tierId);
      if (!tier) {
        return res.status(400).json({
          success: false,
          message: 'Invalid tier ID'
        });
      }
      finalLimit = tier.limit;
    }

    await firestore.setContactLimit(tenantId, finalLimit);
    const tier = contactPricing.getTierByLimit(finalLimit);

    return res.status(200).json({
      success: true,
      message: 'Contact limit updated successfully',
      data: {
        limit: finalLimit,
        tier: tier ? {
          id: tier.id,
          name: tier.name,
          price: tier.price,
          formattedPrice: contactPricing.formatPrice(tier)
        } : null
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to set contact limit',
      error: error.message
    });
  }
}

/**
 * Get contacts list for tenant
 */
async function handleGetContacts(req, res, tenantId) {
  try {
    const { limit = 100 } = req.query;
    const contacts = await firestore.getContacts(tenantId, parseInt(limit));

    return res.status(200).json({
      success: true,
      data: {
        contacts,
        count: contacts.length
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to get contacts',
      error: error.message
    });
  }
}

/**
 * Get all pricing tiers
 */
async function handleGetTiers(req, res) {
  try {
    const tiers = contactPricing.getAllTiers().map(tier => ({
      id: tier.id,
      name: tier.name,
      limit: tier.limit,
      price: tier.price,
      formattedPrice: contactPricing.formatPrice(tier)
    }));

    return res.status(200).json({
      success: true,
      data: { tiers }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to get tiers',
      error: error.message
    });
  }
}

/**
 * Get recommended tier based on current contact count
 */
async function handleGetRecommendedTier(req, res, tenantId) {
  try {
    const contactLimit = await firestore.checkContactLimit(tenantId);
    const recommendedTier = contactPricing.getRecommendedTier(contactLimit.count);
    const nextTier = contactPricing.getNextTier(recommendedTier.id);

    return res.status(200).json({
      success: true,
      data: {
        currentCount: contactLimit.count,
        currentLimit: contactLimit.limit,
        recommendedTier: {
          id: recommendedTier.id,
          name: recommendedTier.name,
          limit: recommendedTier.limit,
          price: recommendedTier.price,
          formattedPrice: contactPricing.formatPrice(recommendedTier)
        },
        nextTier: nextTier ? {
          id: nextTier.id,
          name: nextTier.name,
          limit: nextTier.limit,
          price: nextTier.price,
          formattedPrice: contactPricing.formatPrice(nextTier)
        } : null,
        upgradeMessage: contactPricing.getUpgradeMessage(contactLimit.count, contactLimit.limit)
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to get recommended tier',
      error: error.message
    });
  }
}

