/**
 * Contact Pricing Tiers
 * Defines pricing tiers based on contact count limits
 */
class ContactPricing {
  constructor() {
    this.tiers = [
      { id: '1k', name: '1K Contacts', limit: 1000, price: 0 }, // Free tier
      { id: '2k', name: '2K Contacts', limit: 2000, price: 29 },
      { id: '3k', name: '3K Contacts', limit: 3000, price: 39 },
      { id: '4k', name: '4K Contacts', limit: 4000, price: 49 },
      { id: '5k', name: '5K Contacts', limit: 5000, price: 59 },
      { id: '6k', name: '6K Contacts', limit: 6000, price: 69 },
      { id: '7k', name: '7K Contacts', limit: 7000, price: 79 },
      { id: '8k', name: '8K Contacts', limit: 8000, price: 89 },
      { id: '9k', name: '9K Contacts', limit: 9000, price: 99 },
      { id: '10k', name: '10K Contacts', limit: 10000, price: 109 }
    ];
  }

  /**
   * Get pricing tier by ID
   * @param {string} tierId - Tier ID (e.g., '1k', '2k', etc.)
   * @returns {Object|null} Pricing tier
   */
  getTier(tierId) {
    return this.tiers.find(tier => tier.id === tierId) || null;
  }

  /**
   * Get pricing tier by contact limit
   * @param {number} limit - Contact limit
   * @returns {Object|null} Pricing tier
   */
  getTierByLimit(limit) {
    return this.tiers.find(tier => tier.limit === limit) || null;
  }

  /**
   * Get next tier (for upgrade)
   * @param {string} currentTierId - Current tier ID
   * @returns {Object|null} Next tier
   */
  getNextTier(currentTierId) {
    const currentIndex = this.tiers.findIndex(tier => tier.id === currentTierId);
    if (currentIndex === -1 || currentIndex === this.tiers.length - 1) {
      return null;
    }
    return this.tiers[currentIndex + 1];
  }

  /**
   * Get all tiers
   * @returns {Array} All pricing tiers
   */
  getAllTiers() {
    return this.tiers;
  }

  /**
   * Get recommended tier based on current contact count
   * @param {number} currentCount - Current contact count
   * @returns {Object} Recommended tier
   */
  getRecommendedTier(currentCount) {
    // Find the smallest tier that can accommodate current count
    for (const tier of this.tiers) {
      if (tier.limit >= currentCount) {
        return tier;
      }
    }
    // If exceeds all tiers, return the highest tier
    return this.tiers[this.tiers.length - 1];
  }

  /**
   * Format pricing for display
   * @param {Object} tier - Pricing tier
   * @returns {string} Formatted price string
   */
  formatPrice(tier) {
    if (tier.price === 0) {
      return 'Free';
    }
    return `₦${tier.price.toLocaleString()}/month`;
  }

  /**
   * Get upgrade message for tenant
   * @param {number} currentCount - Current contact count
   * @param {number} currentLimit - Current contact limit
   * @returns {string} Upgrade message
   */
  getUpgradeMessage(currentCount, currentLimit) {
    const usagePercent = (currentCount / currentLimit) * 100;
    
    if (usagePercent >= 90) {
      const recommendedTier = this.getRecommendedTier(currentCount);
      return `⚠️ You've used ${usagePercent.toFixed(0)}% of your contact limit (${currentCount}/${currentLimit}). ` +
             `Upgrade to ${recommendedTier.name} (${recommendedTier.limit} contacts) for ${this.formatPrice(recommendedTier)} to continue receiving messages.`;
    } else if (usagePercent >= 75) {
      return `📊 You've used ${usagePercent.toFixed(0)}% of your contact limit (${currentCount}/${currentLimit}). ` +
             `Consider upgrading to avoid reaching your limit.`;
    }

    return null;
  }
}

module.exports = new ContactPricing();

