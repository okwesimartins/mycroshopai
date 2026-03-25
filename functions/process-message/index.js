const GeminiAI       = require('../../lib/gemini');
const whatsapp       = require('../../lib/whatsapp');
const backendApi     = require('../../lib/backend-api');
const firestore      = require('../../lib/firestore');
const contactPricing = require('../../lib/contact-pricing');

// Patch backendApi calls to log full error details for debugging
const origCheckProduct = backendApi.checkProduct.bind(backendApi);
backendApi.checkProduct = async (tenantId, productName, plan) => {
  try {
    const result = await origCheckProduct(tenantId, productName, plan);
    if (!result) {
      console.warn(`[BackendAPI:checkProduct] returned null for "${productName}" (tenant=${tenantId})`);
    }
    return result;
  } catch (e) {
    const status = e.response?.status;
    const body   = JSON.stringify(e.response?.data || {}).substring(0, 300);
    console.error(`[BackendAPI:checkProduct] FAILED for "${productName}" | HTTP ${status} | ${body} | ${e.message}`);
    return null;
  }
};

const ai = new GeminiAI(process.env.GEMINI_API_KEY || '');

/**
 * processMessage — the conversation engine
 *
 * Flow:
 * 1. Dedup + contact limit check
 * 2. Load conversation history + order state from Firestore
 * 3. Detect intent → pre-fetch product data from backend
 * 4. Call Gemini WITH the product data already injected
 *    → Gemini writes a COMPLETE natural reply using real data
 *    → Gemini also returns actions to execute
 * 5. Execute actions (send images, confirm order, verify payment)
 * 6. Gemini's reply is the message — action results refine/replace only when needed
 * 7. Send to WhatsApp, save history
 *
 * The key insight: Gemini must see real data BEFORE writing the reply.
 * That's what makes it sound natural instead of "Checking now... [separate data dump]"
 */
async function processMessage(messageData) {
  const {
    tenantId,
    accessToken,
    storeName,
    businessBio,
    subscriptionPlan: spRaw,
    defaultOnlineStoreId,
    customerPhone,
    message,
    messageId,
    phoneNumberId,
    quotedMessageId = null,
    incomingImage   = null,
    buttonReply     = null,   // store owner tapped Approve/Decline button
    listReply       = null,   // user selected from list (e.g. time slot: id = slot_<serviceId>_<date>_<time>)
    // Payment configuration from merchant's store settings
    paymentInstructionType = null,
    paypalEmail            = null,
    bankAccountName        = null,
    bankName               = null,
    bankAccountNumber      = null,
    bankCode               = null,
    paymentInstructions    = null,
    ownerWhatsappNumber    = null,
  } = messageData;

  const subscriptionPlan  = spRaw || 'enterprise';
  const storeNameResolved = storeName || 'our store';

  const log    = (tag, ...a) => console.log(`[pm:${tag}]`, ...a);
  const logErr = (tag, err) => {
    console.error(`[pm:ERR:${tag}]`, err?.message || err);
    if (err?.stack) console.error(err.stack.split('\n').slice(0, 4).join('\n'));
  };

  try {
    // ── Guard ────────────────────────────────────────────────────────────
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
    // For image messages, text might be empty — use caption if provided, or a placeholder
    // The image itself carries the content — Gemini will see it via Vision
    const captionText = incomingImage?.caption?.trim() || '';
    const msgText = (message || captionText || (incomingImage ? '[image]' : '')).trim();
    if (!msgText && !incomingImage) { log('skip', 'empty message'); return; }
    log('start', `tenant=${tenantId} customer=${customerPhone} msg="${msgText.substring(0, 80)}"`);

    // ── Parallelised setup reads ─────────────────────────────────────────
    // All three Firestore reads are independent — run simultaneously.
    // This saves ~300-500ms vs sequential awaits on every single message.
    const t0 = Date.now();
    const [isDuplicate, rawHistory, savedOrderState] = await Promise.all([
      // 1. Dedup — did we already process this message ID?
      (messageId && typeof firestore.hasProcessedMessage === 'function')
        ? firestore.hasProcessedMessage(tenantId, messageId).catch(() => false)
        : Promise.resolve(false),

      // 2. Conversation history (last 30 turns)
      typeof firestore.getConversationHistory === 'function'
        ? firestore.getConversationHistory(tenantId, customerPhone).catch(e => { logErr('history', e); return []; })
        : Promise.resolve([]),

      // 3. Active order state (for multi-turn ordering)
      typeof firestore.getOrderState === 'function'
        ? firestore.getOrderState(tenantId, customerPhone).catch(() => null)
        : Promise.resolve(null),
    ]);
    log('setup', `parallel Firestore reads: ${Date.now() - t0}ms`);

    if (isDuplicate) { log('dedup', 'already processed, skipping'); return; }

    // Mark message as read immediately — shows blue ticks to customer
    whatsapp.markAsRead(phoneNumberId, accessToken, messageId).catch(() => {});

    // ── Store owner button reply (Approve / Decline) ─────────────────────
    // When the store owner taps a button on the receipt notification,
    // handle it here and do NOT run the normal AI flow.
    // Booking buttons (bapprove_/bdecline_) are handled first; order buttons (approve_/decline_) second.
    if (buttonReply) {
      const handledAsBooking = await handleBookingOwnerButtonReply({
        buttonReply, tenantId, phoneNumberId, accessToken,
      });
      if (!handledAsBooking) {
        await handleOwnerButtonReply({
          buttonReply, tenantId, phoneNumberId, accessToken,
        });
      }
      return;
    }

    // ── Receipt order selection (list row) ──────────────────────────────────
    // Customer picked which order their previously-sent receipt image belongs to.
    // listReply.id format: receiptorder_<orderId>_<customerPhone>
    if (listReply?.id && String(listReply.id).startsWith('receiptorder_')) {
      await handleReceiptOrderSelection({
        listReply, tenantId, customerPhone, phoneNumberId, accessToken,
        savedOrderState, ownerWhatsappNumber, storeNameResolved,
      });
      return;
    }

    // ── Booking: "More dates" pagination (list row) ─────────────────────────
    if (listReply?.id && String(listReply.id).startsWith('moredates_')) {
      await handleBookingMoreDatesList({
        listReply, tenantId, subscriptionPlan, customerPhone, phoneNumberId, accessToken,
      });
      return;
    }

    // ── Booking: "More times" pagination (list row) ─────────────────────────
    if (listReply?.id && String(listReply.id).startsWith('moretimes_')) {
      await handleBookingMoreTimesList({
        listReply, tenantId, subscriptionPlan, customerPhone, phoneNumberId, accessToken,
      });
      return;
    }

    // ── Booking: user picked a date (then we show times) ───────────────────
    // listReply.id: pickdate_<serviceId>_<YYYYMMDD> e.g. pickdate_6_20260324
    if (listReply?.id && String(listReply.id).startsWith('pickdate_')) {
      await handleBookingDateSelection({
        listReply, tenantId, subscriptionPlan, customerPhone, phoneNumberId, accessToken,
      });
      return;
    }

    // ── Booking: user selected a time slot from interactive list ─────────
    // listReply.id format: slot_<serviceId>_<date>_<time> e.g. slot_5_2025-03-09_09:00
    if (listReply?.id && String(listReply.id).startsWith('slot_')) {
      // Extract any saved customer name/phone from Firestore state for re-use
      const savedCustomerName  = pendingOrder?.customer_name  || null;
      const savedCustomerPhone = pendingOrder?.customer_phone || null;
      const slotResult = await handleBookingSlotSelection({
        listReply, tenantId, subscriptionPlan, customerPhone, phoneNumberId, accessToken,
        storeName: storeNameResolved,
        savedCustomerName, savedCustomerPhone,
      });
      if (slotResult?.pendingBookingSlot) {
        // Customer details not yet collected — save state and wait for their reply
        firestore.saveOrderState?.(tenantId, customerPhone, {
          state: 'booking_collecting_details',
          pending_order: {
            pending_slot: slotResult.pendingBookingSlot,
            customer_name:  savedCustomerName,
            customer_phone: savedCustomerPhone,
          },
        }).catch(() => {});
      } else if (slotResult?.bookingId) {
        // Booking was created right away (customer info was already known) — send payment instructions
        const bookMsg = await buildBookingPaymentMessage({
          tenantId, bookingId: slotResult.bookingId,
          serviceTitle: slotResult.serviceTitle,
          scheduledAt: slotResult.scheduledAt,
          dateLabel: slotResult.dateStr,
          timeLabel: slotResult.timeLabel,
          customerName:  savedCustomerName,
          customerPhone: savedCustomerPhone || customerPhone,
          customerEmail: null,
          service_id: null,
          paymentInstructionType, paypalEmail,
          bankAccountName, bankName, bankAccountNumber, paymentInstructions,
          bookingData: null,
        });
        await safeSend(phoneNumberId, customerPhone, accessToken, bookMsg.text);
        firestore.saveOrderState?.(tenantId, customerPhone, {
          state: bookMsg.isPaystack ? 'idle' : 'booking_awaiting_payment',
          pending_order: bookMsg.isPaystack ? null : {
            booking_id:    slotResult.bookingId,
            service_title: slotResult.serviceTitle,
            scheduled_at:  slotResult.scheduledAt,
            customer_name:  savedCustomerName,
            customer_phone: savedCustomerPhone || customerPhone,
          },
        }).catch(() => {});
      }
      return;
    }

    // Download incoming image — could be a receipt OR a product screenshot
    // Decision is made AFTER we know the order state
    let incomingImageData = null;
    if (incomingImage?.mediaId) {
      log('image', `Customer sent image — downloading media ${incomingImage.mediaId}`);
      incomingImageData = await whatsapp.downloadMedia(incomingImage.mediaId, accessToken)
        .catch(e => { logErr('downloadMedia', e); return null; });
      if (incomingImageData) {
        log('image', `Downloaded ${incomingImageData.mimeType}, ${incomingImageData.base64.length} chars`);
      }
    }

    // Contact limit — only matters for brand new customers (first message ever)
    const isNewCustomer = rawHistory.length === 0;
    if (isNewCustomer && typeof firestore.checkContactLimit === 'function') {
      const limit = await firestore.checkContactLimit(tenantId).catch(() => ({ reached: false }));
      if (limit.reached) {
        await safeSend(phoneNumberId, customerPhone, accessToken,
          `Sorry, this store has reached its contact limit. Please reach out to the merchant directly.`);
      return;
    }
    }

    // Track contact — fire-and-forget, never block the main flow
    firestore.trackContact?.(tenantId, customerPhone).catch(() => {});

    // Sanitise history — strip raw JSON from model turns (old bug: prevents Gemini mirroring format)
    const conversationHistory = rawHistory.map(msg => {
      if (msg.role !== 'user' && typeof msg.text === 'string' && msg.text.trimStart().startsWith('{')) {
        try {
          const parsed = JSON.parse(msg.text);
          if (parsed.reply && typeof parsed.reply === 'string') return { ...msg, text: parsed.reply };
        } catch (_) {
          const m = msg.text.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (m) { try { return { ...msg, text: JSON.parse('"' + m[1] + '"') }; } catch (_2) {} }
        }
      }
      return msg;
    });

    let orderState   = 'idle';
    let pendingOrder = null;
    if (savedOrderState) { orderState = savedOrderState.state || 'idle'; pendingOrder = savedOrderState.pending_order || null; }
    // ── pending_approval: customer CAN still browse/order ──────────────────────
    // We removed the hard block here. Customers in pending_approval state are now
    // free to browse products and place new orders while waiting for receipt confirmation.
    // If they send another receipt image, the multi-order disambiguation flow below
    // will show them a list of their unconfirmed orders to link it to.
    // If in booking_pending_approval state and customer texts, reassure them
    if (orderState === 'booking_pending_approval' && !incomingImageData) {
      const svcTitle = pendingOrder?.service_title || 'your appointment';
      await safeSend(phoneNumberId, customerPhone, accessToken,
        `Your receipt for the ${svcTitle} booking has been received and is being reviewed. ` +
        `You'll get a confirmation here once the store approves it. 🙏`
      );
      return;
    }

    // ── Receipt: customer sent text while waiting to select an order ────────
    // They're in 'receipt_pending_order_selection' — they need to tap the list,
    // not type. Nudge them so they don't get confused.
    if (orderState === 'receipt_pending_order_selection' && !incomingImageData && !listReply) {
      await safeSend(phoneNumberId, customerPhone, accessToken,
        `Please tap the order list I sent to select which order your receipt belongs to. If you can't see it, let me know and I'll resend it.`
      );
      return;
    }

    // ── Booking customer details collection ──────────────────────────────
    // When customer is in 'booking_collecting_details' state, they just picked a slot
    // and we asked for their name + phone. Parse their reply and complete the booking.
    if (orderState === 'booking_collecting_details' && !incomingImageData && !buttonReply && !listReply) {
      const slot = pendingOrder?.pending_slot;
      if (slot) {
        // Extract name and phone from the message using a simple heuristic
        const phoneMatch = msgText.match(/\b(0\d{10}|\+\d{10,14})\b/);
        const extractedPhone = phoneMatch ? phoneMatch[0] : null;
        // Name = everything before the phone number, trimmed
        const extractedName = extractedPhone
          ? msgText.replace(phoneMatch[0], '').replace(/[,\s]+/g, ' ').trim()
          : msgText.trim();

        if (extractedName && extractedPhone) {
          log('booking-details', `Got name="${extractedName}" phone="${extractedPhone}" for slot ${slot.scheduled_at}`);
          // Complete the booking
          const bookResult = await _completeBookingSlot({
            tenantId, subscriptionPlan, customerPhone, phoneNumberId, accessToken,
            serviceId: slot.service_id,
            scheduledAt: slot.scheduled_at,
            dateStr: slot.date,
            timeLabel: slot.time,
            customerName: extractedName,
            customerPhone: extractedPhone,
          });

          if (bookResult) {
            // Send payment instructions (Paystack link or bank details)
            const bookMsg = await buildBookingPaymentMessage({
              tenantId, bookingId: bookResult.bookingId,
              serviceTitle: bookResult.serviceTitle,
              scheduledAt: bookResult.scheduledAt,
              dateLabel: bookResult.dateStr,
              timeLabel: bookResult.timeLabel,
              customerName: extractedName,
              customerPhone: extractedPhone,
              customerEmail: null,
              service_id: slot.service_id,
              paymentInstructionType, paypalEmail,
              bankAccountName, bankName, bankAccountNumber, paymentInstructions,
              bookingData: null,
            });
            await safeSend(phoneNumberId, customerPhone, accessToken, bookMsg.text);
            firestore.saveOrderState?.(tenantId, customerPhone, {
              state: bookMsg.isPaystack ? 'idle' : 'booking_awaiting_payment',
              pending_order: bookMsg.isPaystack ? null : {
                booking_id: bookResult.bookingId,
                service_title: bookResult.serviceTitle,
                scheduled_at: bookResult.scheduledAt,
                customer_name: extractedName,
                customer_phone: extractedPhone,
              },
            }).catch(() => {});
          }
          return;
        } else {
          // Couldn't parse — ask again naturally
          await safeSend(phoneNumberId, customerPhone, accessToken,
            `I just need your full name and phone number (e.g. "Tunde 08031234567") and we're all set.`
          );
          return;
        }
      }
    }

    // ── Receipt intercept ────────────────────────────────────────────────
    // Fires when customer sends an image that is a payment receipt.
    //
    // PRIMARY trigger: state = awaiting_payment + has an order_id in Firestore.
    // SECONDARY trigger: customer quoted a specific order confirmation message.
    //   This handles the multi-order case — customer scrolls back to a specific
    //   order confirmation and replies to it with their receipt. We look up the
    //   exact order_id from the quoted message ID, bypassing Firestore state entirely.
    //
    // This means receipts are always attached to the RIGHT order, even when:
    //   - Customer has multiple pending orders simultaneously
    //   - Firestore state was overwritten by a newer order
    //   - Customer's state is pending_approval for one order but they're paying for another

    // ── Booking receipt intercept ────────────────────────────────────────
    // Fires when customer in 'booking_awaiting_payment' sends an image.
    if (orderState === 'booking_awaiting_payment' && incomingImageData && pendingOrder?.booking_id) {
      await handleBookingReceiptSubmission({
        tenantId, customerPhone, phoneNumberId, accessToken,
        pendingBooking: pendingOrder, incomingImageData,
        ownerWhatsappNumber, storeNameResolved,
      });
      firestore.saveOrderState?.(tenantId, customerPhone, {
        state: 'booking_pending_approval',
        pending_order: pendingOrder,
      }).catch(() => {});
      return;
    }

    const isReceiptByState  = orderState === 'awaiting_payment' && incomingImageData && pendingOrder?.order_id;
    const isReceiptByQuote  = incomingImageData && quotedMessageId; // resolve order from quoted msg
    // Also intercept images when customer is in pending_approval (already submitted one receipt)
    // or when they have no order state but still send an image that might be a receipt.
    const isPossibleReceipt = incomingImageData && (
      isReceiptByState ||
      isReceiptByQuote ||
      orderState === 'pending_approval' ||
      orderState === 'awaiting_payment'
    );
    const isReceiptMessage  = isReceiptByState || isReceiptByQuote;

    // ── Multi-order receipt disambiguation ───────────────────────────────────
    // When the customer sends a receipt image and may have multiple unconfirmed orders,
    // we fetch ALL their pending/awaiting-payment orders.
    //   • 1 order  → attach directly (existing behaviour, no list needed)
    //   • 2+ orders → show an interactive list so customer picks which order the receipt is for
    // This fires when: state=awaiting_payment, state=pending_approval, or any image send
    // where we don't already know the exact order from a quoted message.
    if (incomingImageData && !quotedMessageId) {
      const allPending = await backendApi.getAllPendingOrdersByPhone(tenantId, customerPhone)
        .catch(() => []);

      if (allPending.length >= 2) {
        // Multiple unconfirmed orders — save the receipt image in Firestore state and
        // ask the customer which order it belongs to via an interactive list.
        log('receipt-disambig', `${allPending.length} pending orders found — showing order picker`);

        // Persist the receipt image temporarily so we can use it after selection
        firestore.saveOrderState?.(tenantId, customerPhone, {
          state: 'receipt_pending_order_selection',
          pending_order: {
            ...(pendingOrder || {}),
            // Store the receipt image temporarily for use after order selection
            pending_receipt_base64: incomingImageData.base64,
            pending_receipt_mime:   incomingImageData.mimeType,
          },
        }).catch(() => {});

        // Build WhatsApp interactive list rows — one per unconfirmed order
        const rows = allPending.slice(0, 10).map(o => {
          const num    = o.order_number || `#${o.id}`;
          const items  = (o.OnlineStoreOrderItems || o.items || []);
          const desc   = items.length
            ? items.slice(0, 2).map(i => i.product_name || i.name).join(', ') + (items.length > 2 ? '…' : '')
            : 'Order';
          const total  = o.total ? ` — ₦${Number(o.total).toLocaleString()}` : '';
          return {
            id:          `receiptorder_${o.id}_${customerPhone}`,
            title:       String(`Order ${num}`).slice(0, 24),
            description: String(`${desc}${total}`).slice(0, 72),
          };
        });

        // Acknowledge receipt + ask for order selection
        await safeSend(phoneNumberId, customerPhone, accessToken,
          `Got your receipt. 📸 You have ${allPending.length} orders awaiting confirmation — which one is this payment for?`
        );
        await whatsapp.sendInteractiveList(
          phoneNumberId, accessToken, customerPhone,
          'Tap the button below and select the order this receipt is for:',
          'Select Order',
          [{ title: 'Your Pending Orders', rows }]
        ).catch(e => logErr('receipt-order-list', e));
        return;
      }

      // Only 0 or 1 pending order — fall through to the normal receipt flow
    }

    if (isReceiptMessage) {
      // For quote-based receipts, we may not have pendingOrder yet — create a minimal placeholder
      const receiptPendingOrder = pendingOrder || { order_id: null };

      await handleReceiptSubmission({
        tenantId, customerPhone, phoneNumberId, accessToken,
        pendingOrder: receiptPendingOrder, incomingImageData, incomingImage,
        ownerWhatsappNumber, storeNameResolved,
        quotedMessageId,
      });

      // Update Firestore state — only if we resolved an order_id
      if (isReceiptByState) {
        firestore.saveOrderState?.(tenantId, customerPhone, {
          state: 'pending_approval',
          pending_order: pendingOrder,
        }).catch(() => {});
      }
      return;
    }

        // ── Booking preempt (before catalog + Gemini) ─────────────────────────
    // Fixes: "availability for nail test" without get_availability from the model, and
    // "let me see a list" after a service thread being treated as product catalog.
    let bookingPreempt = null;
    let ranBookingPreemptAttempt = false;
    if (!incomingImageData && !buttonReply && !listReply) {
      const tryBookingPreempt =
        shouldAttemptBookingAvailabilityPreempt(msgText)
        || (isVagueBookingListFollowUp(msgText) && conversationSuggestsActiveBookingContext(conversationHistory));
      if (tryBookingPreempt) {
        ranBookingPreemptAttempt = true;
        bookingPreempt = await handleBookingIntentFromMessage({
          tenantId,
          subscriptionPlan,
          defaultOnlineStoreId,
          message: msgText,
          conversationHistory,
        });
        if (bookingPreempt?.type === 'send_date_list' || bookingPreempt?.type === 'send_slot_list') {
          log('booking-preempt', `handled as ${bookingPreempt.type} (skip catalog + model for this turn)`);
        }
      }
    }

        // ── PRE-FETCH product data ───────────────────────────────────────────
    // Give Gemini REAL product data BEFORE it writes its reply.
    // KEY RULE: If customer says "can I see a picture" after mentioning a specific product,
    // we fetch ONLY that product — not the whole catalog. Prevents catalog dumping.
    let inventoryText = null;
    let prefetchedProducts = null; // cached from pre-fetch — passed to action handlers to avoid double backend calls
    let forcedProductName = null;
    // For incoming images, always pre-fetch the full catalog so Gemini can match the photo to a product
    const inventoryIntent = incomingImageData
      ? { needed: true, search: null, isImageSearch: true }
      : ranBookingPreemptAttempt
        ? { needed: false, search: null }
        : detectInventoryIntent(msgText, conversationHistory, orderState);

    if (inventoryIntent.needed) {
      try {
        // If this is a contextual picture request (customer already said what they want),
        // fetch ONLY that specific product so Gemini doesn't have 16 products to pick from
        const searchTerm = inventoryIntent.search || undefined;
        const limit = searchTerm ? 5 : 20;

        const result = await backendApi.listProducts(tenantId, subscriptionPlan, { search: searchTerm, limit });

        if (result?.products?.length) {
          // For contextual requests (picture of X), inject only the matched product
          const products = inventoryIntent.contextual && result.products.length > 1
            ? result.products.slice(0, 1)  // just the top match
            : result.products;

          inventoryText = formatProductsForPrompt(products);
          prefetchedProducts = products; // cache — action handlers will use this, not re-fetch
          if (inventoryIntent.contextual) {
            forcedProductName = products[0]?.name || searchTerm;
          }
          log('preload', `${products.length} products injected (search: ${searchTerm || 'all'}, contextual: ${!!inventoryIntent.contextual})`);
        } else {
          inventoryText = '[No products found in catalog right now]';
          log('preload', 'no products found');
        }
      } catch (e) {
        logErr('preload', e); // non-fatal — Gemini still responds
      }
    }

    // ── Call Gemini ──────────────────────────────────────────────────────
    // For contextual picture requests, tell Gemini exactly what to do
    let inventoryMeta = null;
    if (inventoryIntent.contextual && forcedProductName) {
      inventoryMeta = `INSTRUCTION: Customer is asking to see a picture of "${forcedProductName}" based on earlier conversation. Emit query_inventory with product_name="${forcedProductName}" and share_media:true. Do NOT use list_inventory. Do NOT send the whole catalog.`;
    } else if (inventoryIntent.colorHint) {
      inventoryMeta = `CONTEXT: Customer wants "${inventoryIntent.colorHint}" color/variant. Check the product variations for this color option and highlight it in your reply. If found, mention it specifically. If not found, suggest the closest available colors.`;
    }

    // If customer explicitly asked for variations in the same message (e.g. "show me sneakers and the variations"),
    // tell Gemini to always emit show_variations — don't leave it to chance
    if (inventoryIntent.wantsVariations && inventoryIntent.search) {
      const varNote = `\nINSTRUCTION: Customer also explicitly asked to see the variations/options. Always emit show_variations action for ${inventoryIntent.search} in your response.`;
      inventoryMeta = (inventoryMeta || '') + varNote;
    }

    // Image search — customer sent a photo, Gemini will identify the product via Vision
    if (inventoryIntent.isImageSearch) {
      inventoryMeta = (inventoryMeta ? inventoryMeta + '\n' : '') +
        'INSTRUCTION: Customer has sent a photo. Identify the product in the image and match it to the catalog below. ' +
        'If matched: show that product with query_inventory + show_variations. ' +
        'If unsure: ask "Is this [your best guess]?" and emit query_inventory for that product.';
    }

    // Resolve quoted message — when customer replies to a specific message ("I want this")
    // WhatsApp sends context.id with the quoted message ID. We find its content from history.
    let quotedContext = null;
    if (quotedMessageId && conversationHistory.length > 0) {
      // Find the most recent assistant message — that's almost certainly what they quoted
      const recentAssistant = [...conversationHistory].reverse().find(m => m.role === 'assistant');
      if (recentAssistant?.text) {
        quotedContext = `[CUSTOMER IS REPLYING TO THIS SPECIFIC MESSAGE: "${recentAssistant.text.substring(0, 300)}"]`;
        log('quoted', `Resolved quoted msg → "${recentAssistant.text.substring(0, 80)}"`);
      }
    }

    const skipGeminiForBooking =
      bookingPreempt
      && (bookingPreempt.type === 'send_date_list'
        || bookingPreempt.type === 'send_slot_list'
        || bookingPreempt.type === 'replace');

    const aiResponse = skipGeminiForBooking
      ? { text: bookingPreempt.type === 'replace' ? (bookingPreempt.text || '') : '', actions: [], order_state: orderState }
      : await ai.processMessage(msgText, {
        tenant_id:            tenantId,
        subscription_plan:    subscriptionPlan,
        customer_phone:       customerPhone,
        store_name:           storeNameResolved,
        business_bio:         businessBio || null,
        conversation_history: conversationHistory,
        order_state:          orderState,
        pending_order:        pendingOrder,
        inventory_meta:       inventoryMeta,
        quoted_context:       quotedContext,
        incomingImage:        incomingImageData,  // base64 image for Gemini Vision
      }, inventoryText).catch(e => { logErr('gemini', e); throw e; });

    log('gemini', skipGeminiForBooking ? 'skipped (booking preempt)' : `reply="${aiResponse.text?.substring(0, 80)}" actions=[${aiResponse.actions?.map(a=>a.type).join(',')||'none'}]`);

    // ── Execute actions ──────────────────────────────────────────────────
    let finalReply    = aiResponse.text || '';
    let newOrderState = aiResponse.order_state || orderState;
    let newPending    = pendingOrder;
    let pendingImages = []; // images to send AFTER the text reply
    let pendingInteractiveList = null; // booking: date picker and/or time slots (WhatsApp list)

    if (bookingPreempt?.type === 'send_date_list' || bookingPreempt?.type === 'send_slot_list') {
      pendingInteractiveList = bookingPreempt;
      finalReply =
        bookingPreempt.introText
        || (bookingPreempt.type === 'send_slot_list'
          ? 'Tap **Pick a time** below to choose a slot.'
          : '')
        || finalReply
        || bookingPreempt.bodyText
        || 'Choose an option below.';
    } else if (bookingPreempt?.type === 'replace' && skipGeminiForBooking) {
      finalReply = bookingPreempt.text || finalReply;
    }

    // Safety net: if Gemini emits list_inventory with share_media for a contextual picture request,
    // convert it to query_inventory for the specific product so we don't dump the whole catalog
    let actionsToRun = aiResponse.actions || [];
    if (inventoryIntent.contextual && forcedProductName) {
      actionsToRun = actionsToRun.map(a => {
        if (a.type === 'list_inventory' && a.share_media) {
          log('ctx-override', `Converting list_inventory→query_inventory for contextual picture: ${forcedProductName}`);
          return { ...a, type: 'query_inventory', intent: 'availability', product_name: forcedProductName, share_media: true };
        }
        return a;
      });
    }

    for (const action of actionsToRun) {
      const result = await handleAction(action, {
        tenantId, subscriptionPlan, defaultOnlineStoreId,
        message: msgText, conversationHistory, customerPhone,
        accessToken, phoneNumberId, pendingOrder,
        aiResponse,
        prefetchedProducts,
        // Payment config — needed by handleOrderCreation
        paymentInstructionType, paypalEmail,
        bankAccountName, bankName, bankAccountNumber, bankCode,
        paymentInstructions,
        // For idempotency: use inbound WhatsApp messageId as key
        messageId,
      });

      if (!result) continue;

      if (result.type === 'order_pending') {
        // Partial order — save collected data, Gemini's collecting-details reply stays
        newPending    = result.pending_order;
        newOrderState = 'collecting_details';

      } else if (result.type === 'replace') {
        finalReply = result.text || finalReply;
        if (result.new_order_state)   newOrderState = result.new_order_state;
        if (result.new_pending_order) newPending    = result.new_pending_order;
        // Order/booking confirmation is the final word — stop processing other actions.
        // Prevents Gemini's co-emitted list_inventory from dumping random product images.
        if (result.new_order_state === 'awaiting_payment' || result.new_order_state === 'booking_awaiting_payment') break;

      } else if (result.type === 'soft_replace') {
        // Soft replace — only overwrite if Gemini wrote a placeholder, not a real answer
        // (Gemini may have already answered perfectly from pre-injected PRODUCT DATA)
        if (isPlaceholder(finalReply) || !finalReply.includes('₦')) {
          finalReply = result.text || finalReply;
        }

      } else if (result.type === 'append_images') {
        // Images sent inline; append formatted catalog text after Gemini's intro
        if (result.text) finalReply = mergeIntroAndData(finalReply, result.text);

      } else if (result.type === 'data') {
        // Backend returned richer data than what was pre-loaded — replace Gemini's text
        // ONLY if Gemini's reply looks like a placeholder (it said "checking" or similar)
        if (result.text && isPlaceholder(finalReply)) {
          finalReply = result.text;
        } else if (result.text) {
          finalReply = mergeIntroAndData(finalReply, result.text);
        }
      } else if (result.type === 'catalog_media') {
        // Catalog with images — Gemini's intro text is the reply, images come after.
        // If the action handler also supplied a text list (e.g. services catalog),
        // merge it into the reply so the customer sees the full list + photos.
        if (result.text) {
          finalReply = mergeIntroAndData(finalReply, result.text);
        }
        if (result.images?.length) {
          pendingImages.push(...result.images);
        }

      } else if (result.type === 'product_card') {
        // Product query: merge variation text into reply, queue images to send after text
        if (result.variationsText) {
          if (!finalReply.includes('•') && !finalReply.includes('Which works')) {
            finalReply = finalReply.trimEnd() + '\n\n' + result.variationsText;
          }
        }
        // result.images is now an array of { url, caption } — one per colour variant
        if (result.images?.length) {
          pendingImages.push(...result.images);
        }

      } else if (result.type === 'send_slot_list' || result.type === 'send_date_list') {
        pendingInteractiveList = result;
        if (result.type === 'send_date_list' && result.introText) {
          finalReply = result.introText;
        }
      } else if (result.type === 'noop') {
        // Action completed (e.g. images sent) but no text change needed — leave finalReply as-is
      }
    }

    // ── Final cleanup ────────────────────────────────────────────────────
    finalReply = (finalReply || '')
      .replace(/\b(list_inventory|query_inventory|create_order|check_payment|show_variations|list_services|get_availability|book_service|request_refund)\b/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/ {2,}/g, ' ')
      // Remove exclamation marks — they read as robotic/bot-like, not human
      // Exception: emoji sequences and order confirmations (✅) are fine
      // Replace "word!" with "word." and "word! " with "word. " naturally
      .replace(/([a-zA-Z0-9])!(?=[^!]|$)/g, (_, c) => c + '.')
      .replace(/\.{2,}/g, '.')   // "word.." → "word."
      .trim();

    // If Gemini returned empty reply (JSON parse failed and no rescue), use a safe default
    if (!finalReply || !finalReply.trim()) {
      finalReply = 'Give me a sec on that.';
    }

    // ── Final JSON leak guard ────────────────────────────────────────────
    // Last-resort safety: if finalReply is still a JSON object string, extract the reply field.
    // This should never happen if the above parsing worked, but belt-and-suspenders.
    if (finalReply.trimStart().startsWith('{')) {
      try {
        const parsed = JSON.parse(finalReply);
        if (parsed.reply && typeof parsed.reply === 'string') {
          log('json-guard', 'Caught JSON leaking to customer — extracting reply field');
          finalReply = parsed.reply.trim();
        }
      } catch (_) {
        // Try regex
        const m = finalReply.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (m) {
          try { finalReply = JSON.parse('"' + m[1] + '"'); } catch (_2) { finalReply = m[1]; }
          log('json-guard', 'Regex-extracted reply from JSON string');
        } else {
          // Completely unparseable JSON — use safe fallback
          finalReply = "Hey, what can I help you with?";
          log('json-guard', 'Could not parse JSON, using safe fallback');
        }
      }
    }

    // ── Persist history BEFORE sending ──────────────────────────────────
    // Save both turns so follow-up messages always read correct history.
    // Each individual save catches its own error — Promise.all will never reject.
    await Promise.all([
      typeof firestore.saveMessage === 'function'
        ? firestore.saveMessage(tenantId, customerPhone, 'user',      msgText,    messageId).catch(e => logErr('saveUser', e))
        : Promise.resolve(),
      typeof firestore.saveMessage === 'function'
        ? firestore.saveMessage(tenantId, customerPhone, 'assistant', finalReply).catch(e => logErr('saveAI', e))
        : Promise.resolve(),
    ]).catch(() => {}); // outer catch — absolutely never let a save failure kill the send

    // ── Send to customer ─────────────────────────────────────────────────
    // TEXT FIRST — customer reads full context (price, variations, question)
    // Capture the returned message ID — needed to link order confirmations to orders.
    const sendResult = await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone, finalReply, messageId)
      .catch(e => { logErr('send', e); throw e; });

    // If this was an order confirmation (state just moved to awaiting_payment),
    // record the link between the WhatsApp message ID and the order.
    // This lets us resolve the exact order when customer replies with their receipt.
    if (newOrderState === 'awaiting_payment' && newPending?.order_id && sendResult?.messageId) {
      backendApi.recordConfirmationMessage(tenantId, newPending.order_id, sendResult.messageId)
        .catch(e => console.error('[pm] recordConfirmationMessage failed:', e.message)); // fire-and-forget
      log('order', `Confirmation msg ${sendResult.messageId} linked to order ${newPending.order_id}`);
    }

    // IMAGES AFTER TEXT — loads after customer has already read the context
    // Parallel send for multiple images
    if (pendingImages.length > 0) {
      await Promise.all(pendingImages.map(img =>
        whatsapp.sendImage(phoneNumberId, accessToken, customerPhone, img.url, img.caption)
          .catch(e => logErr('sendImage', e))
      ));
    }

    // BOOKING: interactive list — pick a date first, then times (same Cloud API)
    if (pendingInteractiveList?.sections?.length) {
      whatsapp.sendInteractiveList(
        phoneNumberId, accessToken, customerPhone,
        pendingInteractiveList.bodyText || 'Choose an option:',
        pendingInteractiveList.buttonText || 'Open',
        pendingInteractiveList.sections
      ).catch(e => logErr('sendInteractiveList', e));
    }

    // ── Remaining writes — fire and forget ───────────────────────────────
    // Order state and dedup are less time-sensitive — fine to write in background.
    Promise.all([
      typeof firestore.saveOrderState === 'function'
        ? firestore.saveOrderState(tenantId, customerPhone, { state: newOrderState, pending_order: newPending }).catch(() => {})
        : null,
      messageId && typeof firestore.markMessageProcessed === 'function'
        ? firestore.markMessageProcessed(tenantId, messageId).catch(() => {})
        : null,
    ].filter(Boolean)).catch(() => {});

      } catch (err) {
    logErr('FATAL', err);
    await safeSend(phoneNumberId, customerPhone, accessToken,
      'Sorry, something went wrong. Try again in a moment.').catch(() => {});
  }
}

// ── Receipt submission ────────────────────────────────────────────────────────
// Called when customer is in 'awaiting_payment' state and sends an image.
// Attaches the receipt to the order, then notifies the store owner with approve/decline buttons.
async function handleReceiptSubmission({
  tenantId, customerPhone, phoneNumberId, accessToken,
  pendingOrder, incomingImageData, incomingImage,
  ownerWhatsappNumber, storeNameResolved, quotedMessageId,
}) {
  const log = (tag, ...a) => console.log(`[receipt:${tag}]`, ...a);

  // ── Resolve exact order_id ───────────────────────────────────────────
  // Priority 1 (most reliable): customer quoted a specific order confirmation message.
  //   → call GET by-confirmation-message to get the exact order_id.
  //   → This is the ONLY reliable way when a customer has multiple pending orders.
  //
  // Priority 2 (fallback): use the order_id stored in Firestore pendingOrder.
  //   → Used when customer just sends an image without quoting (single pending order case).
  //
  // Priority 3: try GET pending-by-phone as a last resort.
  let orderId     = pendingOrder.order_id || null;
  let orderNumber = pendingOrder.order_number || (orderId ? `#${orderId}` : null);

  if (quotedMessageId) {
    log('resolve', `Resolving order from quoted msg ${quotedMessageId}`);
    const resolvedId = await backendApi.getOrderByConfirmationMessage(tenantId, quotedMessageId)
      .catch(e => { console.error('[receipt] getOrderByConfirmationMessage failed:', e.message); return null; });

    if (resolvedId) {
      if (resolvedId !== orderId) {
        log('resolve', `Quoted msg → order ${resolvedId} (overrides Firestore order ${orderId})`);
      } else {
        log('resolve', `Quoted msg confirms Firestore order ${orderId}`);
      }
      orderId = resolvedId;
      orderNumber = `#${orderId}`;
    } else {
      log('resolve', `Quoted msg not in DB — falling back to Firestore order ${orderId}`);
    }
  }

  // Last resort: if still no order_id, look up by phone
  if (!orderId) {
    log('resolve', 'No order_id from state or quote — trying pending-by-phone');
    const latestOrder = await backendApi.getPendingOrderByPhone(tenantId, customerPhone).catch(() => null);
    if (latestOrder?.id) {
      orderId     = latestOrder.id;
      orderNumber = latestOrder.order_number || `#${orderId}`;
      log('resolve', `Found pending order ${orderId} via phone lookup`);
    } else {
      log('resolve', 'No pending order found — cannot attach receipt');
      await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone,
        "I couldn't find a pending order to attach your receipt to. Please make sure you're replying to your order confirmation message, or contact the store directly.",
        null
      );
      return;
    }
  }

  // 1. Attach the receipt to the order in the backend
  log('attach', `order ${orderId}`);
  const attached = await backendApi.attachOrderReceipt(tenantId, orderId, {
    receipt_image_base64: incomingImageData.base64,
    mime_type:            incomingImageData.mimeType,
  }).catch(e => { console.error('[receipt] attachOrderReceipt failed:', e.message); return null; });

  if (!attached) {
    await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone,
      "I couldn't process your receipt right now. Please try again or contact the store directly.",
      null
    );
    return;
  }
  log('attached', 'receipt saved to order');

  // 2. Tell customer their receipt was received
  await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone,
    `✅ Receipt received for Order ${orderNumber}!\n\nThe store is reviewing your payment and will confirm shortly. I'll let you know as soon as it's approved. 🙏`,
    null
  );

  // 3. Notify store owner — send receipt image + order summary + Approve/Decline buttons
  if (!ownerWhatsappNumber) {
    // Log as ERROR so this is visible in Cloud Console — this is a config problem
    console.error(
      `[receipt:owner] MISSING owner_whatsapp_number for tenant ${tenantId}. ` +
      `Receipt for order ${orderNumber} was attached but owner was NOT notified. ` +
      `Fix: ensure resolve-tenant API returns owner_whatsapp_number for this tenant.`
    );
    // Still a success from the customer's perspective — their receipt is saved.
    // But log it loudly so the merchant knows to configure their WhatsApp number.
    return;
  }

  const ownerPhone = ownerWhatsappNumber.replace(/[+\s]/g, '');
  if (!ownerPhone) {
    console.error(`[receipt:owner] owner_whatsapp_number is blank/whitespace for tenant ${tenantId}. Order ${orderNumber} receipt not delivered to owner.`);
    return;
  }

  // Build a clear order summary for the owner
  const itemsSummary = (pendingOrder.items || [])
    .map(i => `• ${i.product_name}${i.quantity > 1 ? ` x${i.quantity}` : ''} — ${fmtN(i.unit_price || i.price || 0)}`)
    .join('\n');

  const ownerBody = [
    `💰 *Payment Receipt — ${storeNameResolved}*`,
    ``,
    `Order: *${orderNumber}*`,
    `Customer: ${pendingOrder.customer_name || 'Unknown'} (${customerPhone})`,
    `Address: ${pendingOrder.shipping_address || 'N/A'}`,
    ``,
    itemsSummary || '(no items)',
    ``,
    pendingOrder.total ? `Total: *${pendingOrder.total}*` : '',
    ``,
    `Customer has sent a payment receipt. Approve or decline below.`,
  ].filter(l => l !== undefined).join('\n');

  // Send the receipt image to the owner first
  const imageUrl = null; // We have base64 but not a URL — send as caption approach
  // Build a short image-not-available fallback if we can't forward the image directly
  // (WhatsApp Cloud API can't forward base64 images — they need a public URL)
  // The receipt IS attached to the order on the backend; owner can view it in the dashboard.
  // We notify them with text + buttons, and the receipt is in their dashboard.
  log('owner', `Sending approval request to ${ownerPhone}`);

  // Encode customer phone into button IDs so we can look them up when owner replies
  const btnApprove = `approve_${orderId}_${customerPhone}`;
  const btnDecline = `decline_${orderId}_${customerPhone}`;

  log('owner', `Attempting interactive buttons to owner ${ownerPhone}`);
  const ownerSendResult = await whatsapp.sendInteractiveButtons(
    phoneNumberId, accessToken, ownerPhone,
    ownerBody,
    [
      { id: btnApprove, title: '✅ Approve' },
      { id: btnDecline, title: '❌ Decline' },
    ],
    `Order ${orderNumber}`,
    `Reply within 24hrs • ${storeNameResolved}`
  ).catch(e => {
    console.error('[receipt:owner] interactive buttons FAILED:', e.message, '| ownerPhone:', ownerPhone);
    return null;
  });

  if (ownerSendResult?.success) {
    log('owner', `Interactive approval request sent to ${ownerPhone} (msgId: ${ownerSendResult.messageId})`);
  } else {
    // Fallback: plain text — interactive buttons may fail on some WhatsApp accounts or channel types
    console.warn(`[receipt:owner] Interactive buttons failed for ${ownerPhone} — falling back to plain text`);
    const fallbackResult = await whatsapp.sendMessage(
      phoneNumberId,
      accessToken,
      ownerPhone,
      `${ownerBody}\n\nTo approve: reply APPROVE ${orderId}\nTo decline: reply DECLINE ${orderId}\n\nOr use your dashboard to approve/decline.`,
      null
    ).catch(e => {
      console.error('[receipt:owner] text fallback ALSO failed:', e.message, '| ownerPhone:', ownerPhone);
      return null;
    });
    if (fallbackResult?.success) {
      log('owner', `Plain-text fallback sent to ${ownerPhone}`);
    } else {
      console.error(`[receipt:owner] BOTH interactive and text notification failed for tenant ${tenantId}, order ${orderNumber}. Owner NOT notified.`);
    }
  }

  log('owner', 'notification flow complete');
}

// ── Receipt order selection handler ──────────────────────────────────────────
// Called when customer taps a row in the "which order is this receipt for?" list.
// Retrieves the saved receipt image from Firestore state, attaches it to the chosen
// order, then notifies the store owner with Approve/Decline buttons.
//
// listReply.id format: "receiptorder_{orderId}_{customerPhone}"
async function handleReceiptOrderSelection({
  listReply, tenantId, customerPhone, phoneNumberId, accessToken,
  savedOrderState, ownerWhatsappNumber, storeNameResolved,
}) {
  const log = (tag, ...a) => console.log(`[receipt-select:${tag}]`, ...a);

  // Parse the order ID from the list reply
  const parts = String(listReply.id || '').split('_');
  // Format: receiptorder_<orderId>_<phone>  (phone may contain underscores)
  if (parts.length < 3 || parts[0] !== 'receiptorder') {
    log('skip', `Unrecognised list reply id: ${listReply.id}`);
    return;
  }
  const orderId     = parseInt(parts[1], 10);
  const orderNumber = listReply.title || `#${orderId}`;

  if (!orderId) {
    log('skip', `Invalid orderId parsed from: ${listReply.id}`);
    await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone,
      "Something went wrong identifying that order. Please try again or contact the store.", null
    ).catch(() => {});
    return;
  }

  log('selected', `Customer chose order ${orderId} (${orderNumber})`);

  // Retrieve the saved receipt image from Firestore order state
  const pendingReceipt = savedOrderState?.pending_order;
  const receiptBase64  = pendingReceipt?.pending_receipt_base64 || null;
  const receiptMime    = pendingReceipt?.pending_receipt_mime   || 'image/jpeg';

  if (!receiptBase64) {
    log('error', 'No saved receipt image found in Firestore state');
    await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone,
      "I couldn't find your receipt image — it may have expired. Please send the receipt photo again and I'll link it to the right order.", null
    ).catch(() => {});
    // Clear the stale selection state
    firestore.saveOrderState?.(tenantId, customerPhone, { state: 'idle', pending_order: null }).catch(() => {});
    return;
  }

  // 1. Attach the receipt to the selected order
  log('attach', `Attaching receipt to order ${orderId}`);
  const attached = await backendApi.attachOrderReceipt(tenantId, orderId, {
    receipt_image_base64: receiptBase64,
    mime_type:            receiptMime,
  }).catch(e => { console.error('[receipt-select] attachOrderReceipt failed:', e.message); return null; });

  if (!attached) {
    await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone,
      "I couldn't attach your receipt right now. Please try sending the photo again.", null
    ).catch(() => {});
    return;
  }
  log('attached', `Receipt saved to order ${orderId}`);

  // 2. Confirm to the customer
  await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone,
    `✅ Got it! Your receipt has been linked to *${orderNumber}*.

The store is reviewing your payment and will confirm shortly. I'll let you know as soon as it's approved. 🙏`,
    null
  ).catch(() => {});

  // 3. Update Firestore — order is now pending_approval, clear the receipt buffer
  firestore.saveOrderState?.(tenantId, customerPhone, {
    state: 'pending_approval',
    pending_order: {
      order_id:     orderId,
      order_number: orderNumber,
    },
  }).catch(() => {});

  // 4. Notify the store owner with Approve / Decline buttons
  if (!ownerWhatsappNumber) {
    console.error(
      `[receipt-select:owner] MISSING owner_whatsapp_number for tenant ${tenantId}. ` +
      `Receipt for order ${orderNumber} attached but owner NOT notified.`
    );
    return;
  }

  const ownerPhone = ownerWhatsappNumber.replace(/[+\s]/g, '');
  if (!ownerPhone) {
    console.error(`[receipt-select:owner] owner_whatsapp_number is blank for tenant ${tenantId}.`);
    return;
  }

  const ownerBody = [
    `💰 *Payment Receipt — ${storeNameResolved}*`,
    ``,
    `Order: *${orderNumber}*`,
    `Customer: ${customerPhone}`,
    ``,
    `Customer has sent a payment receipt and confirmed it belongs to this order.`,
    `Approve or decline below.`,
  ].join('\n');

  const btnApprove = `approve_${orderId}_${customerPhone}`;
  const btnDecline = `decline_${orderId}_${customerPhone}`;

  log('owner', `Sending approval request to ${ownerPhone}`);
  const ownerResult = await whatsapp.sendInteractiveButtons(
    phoneNumberId, accessToken, ownerPhone,
    ownerBody,
    [
      { id: btnApprove, title: '✅ Approve' },
      { id: btnDecline, title: '❌ Decline' },
    ],
    `Order ${orderNumber}`,
    `Reply within 24hrs • ${storeNameResolved}`
  ).catch(e => {
    console.error('[receipt-select:owner] interactive buttons failed:', e.message);
    return null;
  });

  if (ownerResult?.success) {
    log('owner', `Approval request sent (msgId: ${ownerResult.messageId})`);
  } else {
    // Fallback to plain text
    console.warn(`[receipt-select:owner] Buttons failed — falling back to plain text for ${ownerPhone}`);
    await whatsapp.sendMessage(
      phoneNumberId, accessToken, ownerPhone,
      `${ownerBody}

To approve: reply APPROVE ${orderId}
To decline: reply DECLINE ${orderId}

Or use your dashboard to approve/decline.`,
      null
    ).catch(e => console.error('[receipt-select:owner] text fallback failed:', e.message));
  }

  log('done', `Receipt selection flow complete for order ${orderId}`);
}


// ── Owner button reply handler ─────────────────────────────────────────────────
// Called at the TOP of processMessage when a buttonReply is detected.
// The store owner tapped Approve or Decline on the receipt notification.
async function handleOwnerButtonReply({ buttonReply, tenantId, phoneNumberId, accessToken }) {
  const log = (tag, ...a) => console.log(`[owner-btn:${tag}]`, ...a);

  // Button ID format: "approve_{orderId}_{customerPhone}" or "decline_{orderId}_{customerPhone}"
  const parts = (buttonReply.id || '').split('_');
  if (parts.length < 3) {
    log('skip', `Unrecognised button id: ${buttonReply.id}`);
    return;
  }

  const action       = parts[0];          // 'approve' or 'decline'
  const orderId      = parseInt(parts[1], 10);
  const customerPhone = parts.slice(2).join('_'); // phone may contain underscores

  if (!['approve', 'decline'].includes(action) || !orderId) {
    log('skip', `Invalid action/orderId: ${action} / ${orderId}`);
    return;
  }

  log('action', `${action} order ${orderId} for customer ${customerPhone}`);

  // 1. Call the backend confirm endpoint
  let confirmResult;
  try {
    confirmResult = await backendApi.confirmOrderPayment(tenantId, orderId, action);
  } catch (e) {
    console.error('[owner-btn] confirmOrderPayment failed:', e.message);
    await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone,
      `Couldn't ${action} the order right now. Please try again from your dashboard.`, null
    ).catch(() => {});
    return;
  }

  // 2. Notify customer of the outcome
  let customerMsg;
  if (action === 'approve') {
    customerMsg = [
      `🎉 Great news! Your payment has been confirmed.`,
      ``,
      `Order *${confirmResult.order?.order_number || `#${orderId}`}* is now being processed.`,
      `We'll prepare your order and reach out with delivery updates. Thank you! 🙏`,
    ].join('\n');
  } else {
    customerMsg = [
      `Hi, regarding your Order *#${orderId}*:`,
      ``,
      `Unfortunately we couldn't verify your payment receipt. This could be because:`,
      `• The receipt was unclear or incomplete`,
      `• The payment amount didn't match`,
      ``,
      `Please resend a clear photo of your payment receipt, or contact us directly for help.`,
    ].join('\n');
  }

  await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone, customerMsg, null)
    .catch(e => console.error('[owner-btn] customer notify failed:', e.message));

  // 3. Update order state in Firestore
  // On approve: order is done — clear the pending state
  // On decline: go back to awaiting_payment so customer can resubmit
  // We need firestore here — load it from the outer scope module
  const newState = action === 'approve' ? 'complete' : 'awaiting_payment';
  // Note: we pass customerPhone here — Firestore uses this as the document key
  // We don't have pendingOrder here so just update the state field
  firestore.saveOrderState?.(tenantId, customerPhone, {
    state: newState,
    pending_order: action === 'decline'
      ? { order_id: orderId, order_number: confirmResult.order?.order_number }
      : null,
  }).catch(() => {});

  log('done', `Customer notified, state → ${newState}`);
}

// ── Booking receipt submission ────────────────────────────────────────────────
// Called when a customer in 'booking_awaiting_payment' sends an image receipt.
// Attaches the receipt via the new endpoint, then notifies the store owner.
async function handleBookingReceiptSubmission({
  tenantId, customerPhone, phoneNumberId, accessToken,
  pendingBooking, incomingImageData,
  ownerWhatsappNumber, storeNameResolved,
}) {
  const log = (tag, ...a) => console.log(`[booking-receipt:${tag}]`, ...a);

  const bookingId = pendingBooking?.booking_id;
  if (!bookingId) {
    log('error', 'No booking_id in pending booking state');
    await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone,
      "I couldn't find a booking to attach your receipt to. Please contact the store directly.", null
    );
    return;
  }

  log('attach', `booking ${bookingId}`);
  const attached = await backendApi.attachBookingReceipt(tenantId, bookingId, incomingImageData.base64)
    .catch(e => { console.error('[booking-receipt] attachBookingReceipt failed:', e.message); return null; });

  if (!attached) {
    await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone,
      "I couldn't process your receipt right now. Please try again or contact the store.", null
    );
    return;
  }
  log('attached', 'receipt saved to booking');

  // Tell customer receipt was received
  const serviceTitle = pendingBooking?.service_title || 'your appointment';
  await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone,
    `✅ Receipt received for your ${serviceTitle} booking!\n\nThe store is reviewing your payment and will confirm shortly. I'll let you know once it's approved. 🙏`,
    null
  );

  // Notify store owner with Approve/Decline buttons
  if (!ownerWhatsappNumber) {
    console.error(
      `[booking-receipt:owner] MISSING owner_whatsapp_number for tenant ${tenantId}. ` +
      `Receipt for booking #${bookingId} was attached but owner was NOT notified. ` +
      `Fix: ensure resolve-tenant API returns owner_whatsapp_number for this tenant.`
    );
    return;
  }

  const ownerPhone = ownerWhatsappNumber.replace(/[+\s]/g, '');
  if (!ownerPhone) {
    console.error(`[booking-receipt:owner] owner_whatsapp_number is blank for tenant ${tenantId}. Booking #${bookingId} receipt not delivered to owner.`);
    return;
  }
  const ownerBody = [
    `💰 *Booking Payment Receipt — ${storeNameResolved}*`,
    ``,
    `Service: *${serviceTitle}*`,
    `Booking ID: *#${bookingId}*`,
    `Scheduled: ${pendingBooking?.scheduled_at || 'N/A'}`,
    `Customer: ${pendingBooking?.customer_name || 'Unknown'} (${customerPhone})`,
    ``,
    `Customer has sent a payment receipt. Approve or decline below.`,
  ].join('\n');

  const btnApprove = `bapprove_${bookingId}_${customerPhone}`;
  const btnDecline = `bdecline_${bookingId}_${customerPhone}`;

  log('owner', `Attempting interactive buttons to owner ${ownerPhone}`);
  const ownerSendResult = await whatsapp.sendInteractiveButtons(
    phoneNumberId, accessToken, ownerPhone,
    ownerBody,
    [
      { id: btnApprove, title: '✅ Approve' },
      { id: btnDecline, title: '❌ Decline' },
    ],
    `Booking #${bookingId}`,
    `Reply within 24hrs • ${storeNameResolved}`
  ).catch(e => {
    console.error('[booking-receipt:owner] interactive buttons FAILED:', e.message, '| ownerPhone:', ownerPhone);
    return null;
  });

  if (ownerSendResult?.success) {
    log('owner', `Interactive approval request sent to ${ownerPhone} (msgId: ${ownerSendResult.messageId})`);
  } else {
    console.warn(`[booking-receipt:owner] Interactive buttons failed for ${ownerPhone} — falling back to plain text`);
    const fallbackResult = await whatsapp.sendMessage(
      phoneNumberId, accessToken, ownerPhone,
      `${ownerBody}\n\nTo approve: reply APPROVE ${bookingId}\nTo decline: reply DECLINE ${bookingId}\n\nOr use your dashboard to approve/decline.`,
      null
    ).catch(e => {
      console.error('[booking-receipt:owner] text fallback ALSO failed:', e.message, '| ownerPhone:', ownerPhone);
      return null;
    });
    if (fallbackResult?.success) {
      log('owner', `Plain-text fallback sent to ${ownerPhone}`);
    } else {
      console.error(`[booking-receipt:owner] BOTH interactive and text notification failed for tenant ${tenantId}, booking #${bookingId}. Owner NOT notified.`);
    }
  }

  log('owner', 'notification flow complete');
}

// ── Booking owner button reply ────────────────────────────────────────────────
// Called when store owner taps Approve/Decline on a booking payment notification.
// Button ID format: "bapprove_{bookingId}_{customerPhone}" or "bdecline_{...}"
async function handleBookingOwnerButtonReply({ buttonReply, tenantId, phoneNumberId, accessToken }) {
  const log = (tag, ...a) => console.log(`[booking-owner-btn:${tag}]`, ...a);

  const parts = (buttonReply.id || '').split('_');
  // bapprove_<bookingId>_<phone>  →  ['bapprove', bookingId, ...phone]
  if (parts.length < 3 || !['bapprove', 'bdecline'].includes(parts[0])) {
    return false; // not a booking button — let caller handle
  }

  const rawAction  = parts[0];                           // 'bapprove' | 'bdecline'
  const action     = rawAction === 'bapprove' ? 'approve' : 'decline';
  const bookingId  = parseInt(parts[1], 10);
  const customerPhone = parts.slice(2).join('_');

  if (!bookingId) {
    log('skip', `Invalid bookingId: ${bookingId}`);
    return true; // consumed
  }

  log('action', `${action} booking ${bookingId} for customer ${customerPhone}`);

  // 1. Call the confirm-booking-payment endpoint
  let confirmResult;
  try {
    confirmResult = await backendApi.confirmBookingPayment(tenantId, bookingId, action);
  } catch (e) {
    console.error('[booking-owner-btn] confirmBookingPayment failed:', e.message);
    await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone,
      `Couldn't ${action} the booking right now. Please try again from your dashboard.`, null
    ).catch(() => {});
    return true;
  }

  // 2. Notify customer of the outcome
  let customerMsg;
  if (action === 'approve') {
    customerMsg = [
      `🎉 Great news! Your payment for booking *#${bookingId}* has been confirmed.`,
      ``,
      `Your appointment is all set. We'll see you then. 🙏`,
    ].join('\n');
  } else {
    customerMsg = [
      `Hi, regarding your booking *#${bookingId}*:`,
      ``,
      `We couldn't verify your payment receipt. This could be because:`,
      `• The receipt was unclear or incomplete`,
      `• The payment amount didn't match`,
      ``,
      `Please resend a clear photo of your payment receipt, or contact us directly for help.`,
    ].join('\n');
  }

  await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone, customerMsg, null)
    .catch(e => console.error('[booking-owner-btn] customer notify failed:', e.message));

  // 3. Update Firestore state
  const newState = action === 'approve' ? 'booking_complete' : 'booking_awaiting_payment';
  firestore.saveOrderState?.(tenantId, customerPhone, {
    state: newState,
    pending_order: action === 'decline' ? { booking_id: bookingId } : null,
  }).catch(() => {});

  log('done', `Customer notified, booking state → ${newState}`);
  return true; // consumed
}

// ── Booking: user picked a date → show time list for that day ───────────────────
// listReply.id = pickdate_<serviceId>_<YYYYMMDD> (no dashes in date part)
async function handleBookingDateSelection({
  listReply, tenantId, subscriptionPlan, customerPhone, phoneNumberId, accessToken,
}) {
  const log = (tag, ...a) => console.log(`[booking-date:${tag}]`, ...a);
  const m = String(listReply.id || '').match(/^pickdate_(\d+)_(\d{8})$/);
  if (!m) {
    log('skip', 'invalid pickdate id:', listReply.id);
    return;
  }
  const serviceId = parseInt(m[1], 10);
  const compact = m[2];
  const dateStr = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  if (!serviceId || compact.length !== 8) return;

  const svcList = await backendApi.listServices(tenantId, subscriptionPlan, {}).catch(() => null);
  const svc = svcList?.services?.find(s => s.id === serviceId);
  const title = svc?.service_title || 'your appointment';

  const day = await backendApi.getServiceAvailability(tenantId, serviceId, dateStr, subscriptionPlan);
  if (!day?.slots?.length) {
    await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone,
      `No times left for ${title} on ${dateStr}. Pick another date?`, null
    ).catch(() => {});
    return;
  }

  const rows = buildTimeSlotListRows(day.slots, serviceId, dateStr, 0);
  const hasMore = rows.some(r => String(r.id).startsWith('moretimes_'));
  const body = hasMore
    ? `Pick a time for *${title}* on *${dateStr}* (More times → if needed):`
    : `Pick a time for *${title}* on *${dateStr}*:`;
  await whatsapp.sendInteractiveList(
    phoneNumberId, accessToken, customerPhone,
    body,
    'Pick a time',
    [{ title: 'Times', rows }]
  ).catch(e => log('send', e.message));
  log('done', `Sent ${rows.filter(r => !String(r.id).startsWith('moretimes_')).length} time rows (+more?) for ${dateStr}`);
}

// ── Booking: user tapped a time slot from the interactive list ─────────────────
// listReply.id = slot_<serviceId>_YYYY-MM-DD_<HH:mm> (date contains dashes — use regex)
// Instead of booking immediately, we save the pending slot and ask for customer details.
async function handleBookingSlotSelection({
  listReply, tenantId, subscriptionPlan, customerPhone, phoneNumberId, accessToken, storeName,
  savedCustomerName, savedCustomerPhone,
}) {
  const log = (tag, ...a) => console.log(`[booking-slot:${tag}]`, ...a);
  const id = String(listReply.id || '');
  const m = id.match(/^slot_(\d+)_(\d{4}-\d{2}-\d{2})_(.+)$/);
  if (!m) {
    log('skip', 'invalid slot id:', listReply.id);
    return null;
  }
  const serviceId = parseInt(m[1], 10);
  const dateStr = m[2];
  const timeStr = m[3];
  if (!serviceId || !dateStr || !timeStr) {
    log('skip', 'missing service/date/time');
    return null;
  }
  const hm = /^\d{1,2}:\d{2}$/.test(timeStr) ? timeStr : `${timeStr.slice(0, 2)}:${timeStr.slice(2, 4)}`;
  const scheduledAt = `${dateStr}T${hm}:00`;
  const timeLabel = (listReply.title && /[\d:]+/.test(listReply.title)) ? listReply.title : timeStr;

  // If we already have the customer name and phone from earlier in the conversation, book right away.
  if (savedCustomerName && savedCustomerPhone) {
    log('book', `Using saved customer info: ${savedCustomerName} / ${savedCustomerPhone}`);
    return await _completeBookingSlot({
      tenantId, subscriptionPlan, customerPhone, phoneNumberId, accessToken,
      serviceId, scheduledAt, dateStr, timeLabel,
      customerName: savedCustomerName, customerPhone: savedCustomerPhone,
    });
  }

  // No customer info yet — save the pending slot in a return value so the caller
  // can persist it to Firestore and ask for details.
  log('pending', `Slot selected ${scheduledAt} — asking for customer details`);
  await whatsapp.sendMessage(
    phoneNumberId, accessToken, customerPhone,
    `Almost done — what\'s your name and best phone number for the booking?`,
    null
  ).catch(() => {});

  // Return the pending booking data so processMessage can save it to Firestore
  return {
    pendingBookingSlot: { service_id: serviceId, scheduled_at: scheduledAt, date: dateStr, time: timeLabel },
  };
}

// Complete the booking after customer details are confirmed
async function _completeBookingSlot({
  tenantId, subscriptionPlan, customerPhone, phoneNumberId, accessToken,
  serviceId, scheduledAt, dateStr, timeLabel, customerName, customerPhone: custPhone,
}) {
  const log = (tag, ...a) => console.log(`[booking-complete:${tag}]`, ...a);
  try {
    const data = await backendApi.createBooking(tenantId, {
      service_id: serviceId,
      scheduled_at: scheduledAt,
      customer_name: customerName,
      customer_phone: custPhone,
      subscription_plan: subscriptionPlan,
    });
    const booking = data?.data?.booking;
    const bookingId = booking?.id;
    const serviceTitle = booking?.service_title || 'your appointment';
    log('done', `Booking ${bookingId} created for ${scheduledAt}`);
    return { bookingId, serviceTitle, scheduledAt, dateStr, timeLabel };
  } catch (e) {
    console.error('[booking-complete] createBooking failed:', e.message);
    await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone,
      "We couldn\'t complete the booking right now. Please try again or contact the store directly.", null
    ).catch(() => {});
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Action Handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleAction(action, ctx) {
  const { tenantId, subscriptionPlan, defaultOnlineStoreId,
          message, conversationHistory, customerPhone,
          accessToken, phoneNumberId, pendingOrder,
          aiResponse, prefetchedProducts,
          paymentInstructionType, paypalEmail,
          bankAccountName, bankName, bankAccountNumber, bankCode,
          paymentInstructions,
          messageId } = ctx;
  try {
    switch (action.type) {
      case 'list_services':
        // GUARD 1: If customer is clearly talking about paying for/buying a product they
        // discussed in this conversation, NEVER show services — ask for order details instead.
        if (isProductPurchasePaymentIntent(message, conversationHistory, orderState)) {
          const lastProduct = extractLastProduct(conversationHistory);
          if (lastProduct) {
            return {
              type: 'replace',
              text: `To place your order for the ${lastProduct}, I just need your name, phone number, and delivery address — what are those?`,
            };
          }
          return {
            type: 'replace',
            text: `Sure, let's get your order placed. What's your name, phone number, and delivery address?`,
          };
        }
        // GUARD 2: Gemini often emits list_services for booking DATE/availability questions —
        // route those to the availability flow instead of dumping the full service list.
        if (isBookingDateOrAvailabilityQuery(message) || shouldRouteListServicesToBooking(message)) {
          return await handleBookingIntentFromMessage({
            tenantId, subscriptionPlan, defaultOnlineStoreId, message, conversationHistory,
          });
        }
        return await handleListServices({
          tenantId, subscriptionPlan, defaultOnlineStoreId,
        });

      case 'get_availability':
        if (!action.service_id) {
          return await handleBookingIntentFromMessage({
            tenantId, subscriptionPlan, defaultOnlineStoreId, message, conversationHistory,
          });
        }
        return await handleGetAvailability({
          tenantId, subscriptionPlan,
          service_id: action.service_id,
          date: action.date || null,
          service_title: action.service_title,
        });

      case 'book_service':
        return await handleBookService({
          tenantId, subscriptionPlan, customerPhone,
          service_id: action.service_id,
          scheduled_at: action.scheduled_at,
          customer_name: action.customer_name,
          customer_phone: action.customer_phone || customerPhone,
          customer_email: action.customer_email,
          // Payment config so booking confirmation includes payment instructions
          paymentInstructionType, paypalEmail,
          bankAccountName, bankName, bankAccountNumber, paymentInstructions,
        });

      case 'list_inventory':
        if (
          isBookingIntentMessage(message)
          || (isVagueBookingListFollowUp(message) && conversationSuggestsActiveBookingContext(conversationHistory))
        ) {
          return await handleBookingIntentFromMessage({
            tenantId, subscriptionPlan, defaultOnlineStoreId, message, conversationHistory,
          });
        }
        return await handleListInventory({
          tenantId, subscriptionPlan,
          search:      action.search      ?? null,
          share_media: action.share_media === true,
          accessToken, phoneNumberId, customerPhone, conversationHistory,
          prefetchedProducts, // use cached data if available
        });

      case 'query_inventory':
        if (
          isBookingIntentMessage(message)
          || (isVagueBookingListFollowUp(message) && conversationSuggestsActiveBookingContext(conversationHistory))
        ) {
          return await handleBookingIntentFromMessage({
            tenantId, subscriptionPlan, defaultOnlineStoreId, message, conversationHistory,
          });
        }
        return await handleQueryInventory({
          tenantId, subscriptionPlan,
          productName:      action.product_name || extractProductName(message),
          intent:           action.intent,
          share_media:      action.share_media !== false,
          optionRequested:  action.option_requested || null, // specific variant customer asked for
          accessToken, phoneNumberId, customerPhone,
          prefetchedProducts,
        });

      case 'show_variations': {
        const varProductName = action.product_name || extractLastProduct(conversationHistory);
        // Skip if query_inventory already ran for this same product this turn
        const queryRanForSameProduct = (aiResponse?.actions || []).some(a =>
          a.type === 'query_inventory' &&
          (a.product_name || '').toLowerCase() === (varProductName || '').toLowerCase()
        );
        return await handleShowVariations(
          tenantId, subscriptionPlan,
          varProductName,
          queryRanForSameProduct,
          prefetchedProducts, // avoid re-fetch
        );
      }

      case 'create_order':
        return await handleOrderCreation({
          tenantId, subscriptionPlan, defaultOnlineStoreId,
          message, conversationHistory, customerPhone,
          orderDataFromGemini: action.order_data || null,
          pendingOrder,
          paymentInstructionType, paypalEmail,
          bankAccountName, bankName, bankAccountNumber, bankCode,
          paymentInstructions,
          messageId,
        });

      case 'check_payment':
        return await handlePaymentCheck(tenantId, message);

      case 'request_refund':
        return await handleRefundRequest({
          tenantId,
          customerPhone,
          customerName:  action.customer_name  || pendingOrder?.customer_name  || null,
          customerEmail: action.customer_email || pendingOrder?.customer_email || null,
          orderId:       action.order_id       || pendingOrder?.order_id       || null,
          receiptId:     action.receipt_id     || null,
          reason:        action.reason         || null,
          details:       action.details        || null,
        });

      default:
        console.warn('[handleAction] unknown action:', action.type);
        return null;
    }
  } catch (err) {
    console.error('[handleAction] error in', action.type, err?.message);
    // For order creation failures, tell the customer explicitly — don't silently eat the error
    // while showing them "payment details will follow" from Gemini's reply
    if (action.type === 'create_order') {
      return {
        type: 'replace',
        text: "There was an issue placing your order. Please try again in a moment or contact the store directly.",
      };
    }
    return null;
  }
}

// ── List inventory ────────────────────────────────────────────────────────────
async function handleListInventory({ tenantId, subscriptionPlan, search, share_media,
    accessToken, phoneNumberId, customerPhone, conversationHistory, prefetchedProducts }) {

  // Use pre-fetched products if available (same search term already loaded before Gemini call)
  // This avoids a duplicate backend call — saves ~200-500ms
  let products;
  if (prefetchedProducts?.length) {
    products = prefetchedProducts;
    console.log(`[listInventory] using ${products.length} pre-fetched products (no backend call)`);
  } else {
    const result = await backendApi.listProducts(tenantId, subscriptionPlan, {
      search: search || undefined,
      limit:  search ? 12 : 20,
    });
    if (!result?.products?.length) {
      return {
        type: 'replace',
        text: search
          ? `We don't have anything matching "${search}" right now. Want to see the full catalog?`
          : "Catalog's being updated right now. Ask about a specific product and I'll check for you.",
      };
    }
    products = result.products;
  }
  const base = (process.env.BACKEND_BASE_URL || process.env.MYCROSHOP_API_URL || 'https://backend.mycroshop.com').replace(/\/$/, '');

  // Build readable catalog text
  let text = '';
  products.forEach((p, i) => {
    const { line } = priceStock(p);
    text += `${i + 1}. ${p.name} – ${line}\n`;
  });
  if (products.length > 1) text += '\nWhich one are you interested in?';

  if (share_media) {
    // Return image URLs to the main flow — images sent AFTER text, not before
    // Use priority: variant image → variation-option image → product image
    const imgs = products
      .map(p => ({ url: pickProductImageUrl(p, base), p }))
      .filter(x => x.url)
      .slice(0, 5)
      .map(x => ({ url: x.url, caption: `${x.p.name} – ${priceStock(x.p).line}` }));
    return { type: 'catalog_media', images: imgs };
  }

  return { type: 'data', text: text.trim() };
}

// WhatsApp interactive lists: max 10 rows total — reserve 1 row for "More dates" / "More times"
const WA_DATE_OPTIONS_PER_PAGE = 8;
const WA_TIME_OPTIONS_PER_PAGE = 8;

function ymdAddDays(ymd, deltaDays) {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
  const dt = new Date(y, m - 1, d + deltaDays);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** Rows for one page of time slots; optional "More times" row (id moretimes_...) */
function buildTimeSlotListRows(allSlots, serviceId, dateStr, startOffset = 0) {
  const slots = allSlots || [];
  const slice = slots.slice(startOffset, startOffset + WA_TIME_OPTIONS_PER_PAGE);
  const rows = slice.map(s => ({
    id: `slot_${serviceId}_${dateStr}_${s.slot}`,
    title: String(s.label).slice(0, 24),
  }));
  if (startOffset + slice.length < slots.length) {
    const nextOff = startOffset + slice.length;
    rows.push({
      id: `moretimes_${serviceId}_${String(dateStr).replace(/-/g, '')}_${nextOff}`,
      title: 'More times →',
      description: 'Next slots',
    });
  }
  return rows;
}

/**
 * First page or "More dates" — fetches up to (page size + 1) bookable days to detect hasMore.
 * @param {string|null} scanFromYmd - YYYY-MM-DD for next page; null = backend default (today)
 */
async function buildDateListInteractiveResult(tenantId, subscriptionPlan, serviceId, serviceTitle, scanFromYmd = null) {
  const fetchCount = WA_DATE_OPTIONS_PER_PAGE + 1;
  const opts = { days: fetchCount };
  if (scanFromYmd) opts.from = scanFromYmd;

  const range = await backendApi.getServiceAvailability(tenantId, serviceId, null, subscriptionPlan, opts);
  const withSlots = (range?.dates || []).filter(d => d.slots?.length > 0);

  if (!withSlots.length || !range.total_slots) {
    if (scanFromYmd) {
      return {
        type: 'replace',
        text: 'No more bookable days in that range. Try typing a date (e.g. 2026-04-15) or ask for availability again.',
      };
    }
    return {
      type: 'replace',
      text: `No open slots for ${serviceTitle || 'this service'} right now. Try a specific date or contact the store.`,
    };
  }

  const hasMore = withSlots.length > WA_DATE_OPTIONS_PER_PAGE;
  const pageDates = hasMore ? withSlots.slice(0, WA_DATE_OPTIONS_PER_PAGE) : withSlots;
  const lastDate = pageDates[pageDates.length - 1].date;
  const nextFrom = hasMore ? ymdAddDays(lastDate, 1) : null;

  const rows = pageDates.map(d => ({
    id: `pickdate_${serviceId}_${String(d.date).replace(/-/g, '')}`,
    title: formatShortDateForWhatsappList(d.date),
    description: `${d.slots.length} slot${d.slots.length === 1 ? '' : 's'}`.slice(0, 72),
  }));

  if (nextFrom) {
    rows.push({
      id: `moredates_${serviceId}_${nextFrom.replace(/-/g, '')}`,
      title: 'More dates →',
      description: 'Later days',
    });
  }

  return {
    type: 'send_date_list',
    introText: scanFromYmd
      ? `Here are more days you can book for *${serviceTitle || 'this service'}*.`
      : `To choose a day: tap the *Pick a date* button on the next message, then tap your day in the list. After that you’ll pick a time the same way.`,
    bodyText: nextFrom
      ? 'Tap the button, then select a date (use More dates → at the bottom for later days).'
      : 'Tap the button below, then select your date from the list.',
    buttonText: 'Pick a date',
    sections: [{ title: 'Dates', rows }],
  };
}

async function handleBookingMoreDatesList({
  listReply, tenantId, subscriptionPlan, customerPhone, phoneNumberId, accessToken,
}) {
  const log = (tag, ...a) => console.log(`[booking-moredates:${tag}]`, ...a);
  const m = String(listReply.id || '').match(/^moredates_(\d+)_(\d{8})$/);
  if (!m) {
    log('skip', 'bad id', listReply.id);
    return;
  }
  const serviceId = parseInt(m[1], 10);
  const compact = m[2];
  const scanFrom = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  if (!serviceId || compact.length !== 8) return;

  const svcList = await backendApi.listServices(tenantId, subscriptionPlan, {}).catch(() => null);
  const svc = svcList?.services?.find(s => s.id === serviceId);
  const title = svc?.service_title || 'your appointment';

  const result = await buildDateListInteractiveResult(tenantId, subscriptionPlan, serviceId, title, scanFrom);
  if (result.type === 'replace') {
    await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone, result.text, null).catch(() => {});
    return;
  }
  if (result.introText) {
    await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone, result.introText, null).catch(() => {});
  }
  await whatsapp.sendInteractiveList(
    phoneNumberId, accessToken, customerPhone,
    result.bodyText,
    result.buttonText,
    result.sections
  ).catch(e => log('send', e.message));
}

async function handleBookingMoreTimesList({
  listReply, tenantId, subscriptionPlan, customerPhone, phoneNumberId, accessToken,
}) {
  const log = (tag, ...a) => console.log(`[booking-moretimes:${tag}]`, ...a);
  const m = String(listReply.id || '').match(/^moretimes_(\d+)_(\d{8})_(\d+)$/);
  if (!m) {
    log('skip', 'bad id', listReply.id);
    return;
  }
  const serviceId = parseInt(m[1], 10);
  const dateStr = `${m[2].slice(0, 4)}-${m[2].slice(4, 6)}-${m[2].slice(6, 8)}`;
  const startOffset = parseInt(m[3], 10);
  if (!serviceId || !dateStr || Number.isNaN(startOffset)) return;

  const svcList = await backendApi.listServices(tenantId, subscriptionPlan, {}).catch(() => null);
  const svc = svcList?.services?.find(s => s.id === serviceId);
  const title = svc?.service_title || 'your appointment';

  const day = await backendApi.getServiceAvailability(tenantId, serviceId, dateStr, subscriptionPlan);
  if (!day?.slots?.length) {
    await whatsapp.sendMessage(phoneNumberId, accessToken, customerPhone,
      `No times left for ${title} on ${dateStr}.`, null
    ).catch(() => {});
    return;
  }

  const rows = buildTimeSlotListRows(day.slots, serviceId, dateStr, startOffset);
  const body = `More times for *${title}* on *${dateStr}*:`;
  await whatsapp.sendInteractiveList(
    phoneNumberId, accessToken, customerPhone,
    body,
    'Pick a time',
    [{ title: 'Times', rows }]
  ).catch(e => log('send', e.message));
}

// ── Booking: list services ────────────────────────────────────────────────────
// Returns text list + queues service images to send after the text (same pattern as products)
async function handleListServices({ tenantId, subscriptionPlan, defaultOnlineStoreId }) {
  const result = await backendApi.listServices(tenantId, subscriptionPlan, {
    ...(defaultOnlineStoreId ? { online_store_id: defaultOnlineStoreId } : {})
  });
  if (!result?.services?.length) {
    return { type: 'replace', text: "We don't have any bookable services at the moment. Ask again later or contact the store." };
  }

  const services = result.services;
  const lines = services.map((s, i) => {
    const price = s.price ? `₦${Number(s.price).toLocaleString()}` : 'Price on request';
    return `${i + 1}. ${s.service_title} – ${s.duration_minutes || 30} min, ${price}`;
  });
  const text = `Here are our services:\n\n${lines.join('\n')}\n\nWhich one would you like to book, and for which date?`;

  // Collect service images — send after the text list (same UX as product catalog with photos)
  const images = services
    .filter(s => s.service_image_url && s.service_image_url.startsWith('http'))
    .slice(0, 5)
    .map(s => {
      const price = s.price ? ` — ₦${Number(s.price).toLocaleString()}` : '';
      const dur   = s.duration_minutes ? ` (${s.duration_minutes} min)` : '';
      return { url: s.service_image_url, caption: `${s.service_title}${price}${dur}` };
    });

  if (images.length > 0) {
    // Return catalog_media so the main flow sends text first, then images
    return { type: 'catalog_media', text, images };
  }

  return { type: 'data', text };
}

// ── Booking: get availability and return interactive slot list ──────────────────
async function handleGetAvailability({ tenantId, subscriptionPlan, service_id, date, service_title }) {
  if (!service_id) return null;

  // Single day
  if (date) {
    const result = await backendApi.getServiceAvailability(tenantId, service_id, date, subscriptionPlan);
    if (!result?.slots?.length) {
      return {
        type: 'replace',
        text: `No available slots for ${service_title || 'this service'} on ${date}. Pick another date?`,
      };
    }
    const rows = buildTimeSlotListRows(result.slots, service_id, date, 0);
    const hasMore = rows.some(r => String(r.id).startsWith('moretimes_'));
    return {
      type: 'send_slot_list',
      bodyText: hasMore
        ? `Pick a time for ${service_title || 'your appointment'} on ${date} (tap More times → if needed):`
        : `Pick a time for ${service_title || 'your appointment'} on ${date}:`,
      buttonText: 'Pick a time',
      sections: [{ title: 'Available times', rows }],
    };
  }

  // No date: paginated bookable dates (8 + "More dates →" when needed)
  return buildDateListInteractiveResult(
    tenantId,
    subscriptionPlan,
    service_id,
    service_title,
    null
  );
}

// ── Booking: create booking (when Gemini has all details) ──────────────────────
async function handleBookService({
  tenantId, subscriptionPlan, customerPhone,
  service_id, scheduled_at, customer_name, customer_phone, customer_email,
  paymentInstructionType, paypalEmail, bankAccountName, bankName, bankAccountNumber, paymentInstructions,
}) {
  if (!service_id || !scheduled_at || !customer_name || !customer_phone) return null;
  try {
    const data = await backendApi.createBooking(tenantId, {
      service_id,
      scheduled_at,
      customer_name,
      customer_phone,
      customer_email,
      subscription_plan: subscriptionPlan,
    });
    const b = data?.data?.booking;
    const bookingId   = b?.id;
    const serviceTitle = b?.service_title || 'your appointment';
    const at = b?.scheduled_at ? new Date(b.scheduled_at) : null;
    const timeStr = at ? at.toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' }) : scheduled_at;
    const dateStr = at ? at.toLocaleDateString('en-NG') : scheduled_at;

    const isPaystack = (paymentInstructionType || '').toLowerCase() === 'paystack';
    let resolvedPaymentLink = null;

    if (isPaystack && bookingId) {
      const customerEmail = customer_email || `${(customer_phone || customerPhone).replace(/[^\d]/g, '')}@wa.mycroshop.local`;
      const paymentLinkResult = await backendApi.initializePaymentLink({
        tenant_id:          tenantId,
        amount:             b?.price != null ? parseFloat(b.price) : 0,
        email:              customerEmail,
        name:               customer_name || 'WhatsApp Customer',
        currency:           'NGN',
        customer_phone:     (customer_phone || customerPhone).replace(/[^\d+]/g, ''),
        whatsapp_message_id: null,
        metadata: {
          source:         'whatsapp_ai',
          channel:        'whatsapp',
          flow:           'service_booking',
          tenant_id:      tenantId,
          booking_id:     bookingId,
          service_id:     service_id,
          service_title:  serviceTitle,
          scheduled_at:   scheduled_at,
          timezone:       'Africa/Lagos',
          location_type:  b?.location_type || 'in_person',
          customer_name:  customer_name || 'WhatsApp Customer',
          customer_phone: (customer_phone || customerPhone).replace(/[^\d+]/g, ''),
          customer_email: customer_email || customerEmail,
          payment_context: {
            origin:       'ai_sales_agent',
            initiated_at: new Date().toISOString(),
          },
        },
      }).catch(e => { console.error('[booking] initializePaymentLink failed:', e.message); return null; });

      if (paymentLinkResult?.payment_link) {
        resolvedPaymentLink = paymentLinkResult.payment_link;
        console.log(`[booking] Paystack link generated for booking ${bookingId}: ${resolvedPaymentLink}`);
      } else {
        console.warn(`[booking] Paystack link generation failed for booking ${bookingId} — falling back`);
      }
    }

    const payInstructions = buildPaymentInstructions({
      paymentInstructionType, paypalEmail,
      bankAccountName, bankName, bankAccountNumber,
      paymentInstructions, total: null, paymentLink: resolvedPaymentLink,
    });

    const confirmMsg = [
      `✅ *Booking Confirmed!*`,
      ``,
      `Service: *${serviceTitle}*`,
      `Date & Time: *${dateStr} at ${timeStr}*`,
      ``,
      payInstructions,
      isPaystack ? '' : ``,
      isPaystack ? '' : `Once you've paid, *send me a photo of your receipt* and I'll notify the store right away. 📸`,
    ].filter(l => l !== '').join('\n');

    return {
      type: 'replace',
      text: confirmMsg,
      // Paystack: payment handled online — no receipt flow needed
      new_order_state: isPaystack ? 'idle' : 'booking_awaiting_payment',
      new_pending_order: isPaystack ? null : {
        booking_id:    bookingId,
        service_title: serviceTitle,
        scheduled_at:  scheduled_at,
        customer_name:  customer_name,
        customer_phone: customer_phone || customerPhone,
      },
    };
  } catch (e) {
    console.error('[book_service] createBooking failed:', e.message);
    return {
      type: 'replace',
      text: "We couldn't complete the booking right now. Please try again or contact the store directly.",
    };
  }
}

// ── Booking: infer service/date from natural user message ─────────────────────
async function handleBookingIntentFromMessage({
  tenantId, subscriptionPlan, defaultOnlineStoreId, message, conversationHistory = [],
}) {
  const servicesResult = await backendApi.listServices(tenantId, subscriptionPlan, {
    ...(defaultOnlineStoreId ? { online_store_id: defaultOnlineStoreId } : {})
  });
  const services = servicesResult?.services || [];
  if (!services.length) {
    return { type: 'replace', text: "We don't have any bookable services at the moment." };
  }

  let pickedService = pickServiceFromUserMessage(services, message);
  if (!pickedService && conversationHistory?.length) {
    pickedService = pickServiceFromConversationHistory(services, conversationHistory);
  }
  const parsedDate = extractDateFromMessage(message);
  const vagueListFollowUp = isVagueBookingListFollowUp(message);

  if (pickedService && parsedDate) {
    return await handleGetAvailability({
      tenantId, subscriptionPlan,
      service_id: pickedService.id,
      date: parsedDate,
      service_title: pickedService.service_title,
    });
  }

  if (pickedService && !parsedDate) {
    const showDatePicker =
      isBookingDateOrAvailabilityQuery(message)
      || (vagueListFollowUp && conversationSuggestsActiveBookingContext(conversationHistory));

    if (showDatePicker) {
      return await handleGetAvailability({
        tenantId, subscriptionPlan,
        service_id: pickedService.id,
        date: null,
        service_title: pickedService.service_title,
      });
    }
    const price = pickedService.price != null ? `₦${Number(pickedService.price).toLocaleString()}` : '';
    const dur = pickedService.duration_minutes || 30;
    const detail = [dur && `${dur} min`, price].filter(Boolean).join(' · ');
    return {
      type: 'replace',
      text:
        `For *${pickedService.service_title}*${detail ? ` (${detail})` : ''}:\n\n` +
        `Tell me which *date* you want (e.g. March 30 or 2026-03-30) and I'll show the available time slots to pick from.`,
    };
  }

  const lines = services.slice(0, 10).map((s, i) => `${i + 1}. ${s.service_title}`);
  return {
    type: 'replace',
    text: `I can help you book a service. Here are available services:\n\n${lines.join('\n')}\n\nTell me the service and date (e.g. "Nail test on 2026-03-30").`,
  };
}

// ── Query specific product ────────────────────────────────────────────────────
async function handleQueryInventory({ tenantId, subscriptionPlan, productName, intent,
    share_media = true, optionRequested = null, accessToken, phoneNumberId, customerPhone, prefetchedProducts }) {

    if (!productName) {
    console.warn('[queryInventory] called with no product_name — skipping action, using Gemini reply');
    return null;
  }

  const base  = (process.env.BACKEND_BASE_URL || process.env.MYCROSHOP_API_URL || 'https://backend.mycroshop.com').replace(/\/$/, '');

  // Use pre-fetched products first — find the best match by name
  // This avoids checkProduct + listProducts calls (saves ~400-800ms)
  let product = null;
  if (prefetchedProducts?.length) {
    product = prefetchedProducts.find(p =>
      p.name?.toLowerCase() === productName.toLowerCase()
    ) || prefetchedProducts.find(p =>
      p.name?.toLowerCase().includes(productName.toLowerCase())
    ) || prefetchedProducts.find(p =>
      productName.toLowerCase().includes(p.name?.toLowerCase())
    ) || (prefetchedProducts.length === 1 ? prefetchedProducts[0] : null);

    if (product) {
      console.log(`[queryInventory] using pre-fetched product: ${product.name} (no backend call)`);
    }
  }

  // Only hit backend if pre-fetch didn't have a match
  if (!product) {
    try {
      const checkResult = await backendApi.checkProduct(tenantId, productName, subscriptionPlan);
      if (checkResult?.exists && checkResult.product) {
        product = checkResult.product;
      }
    } catch (e) {
      console.warn('[queryInventory] checkProduct error:', e.message);
    }
  }

  if (!product) {
    try {
      const searchResult = await backendApi.listProducts(tenantId, subscriptionPlan, { search: productName, limit: 5 });
      if (searchResult?.products?.length) {
        product = searchResult.products.find(p =>
          p.name?.toLowerCase() === productName.toLowerCase()
        ) || searchResult.products.find(p =>
          p.name?.toLowerCase().includes(productName.toLowerCase())
        ) || searchResult.products[0];
      }
    } catch (e) {
      console.error('[queryInventory] listProducts fallback failed:', e.message);
    }
  }

  if (!product) {
    try {
      const broad = await backendApi.listProducts(tenantId, subscriptionPlan, {
        search: productName.split(' ')[0], limit: 5
      });
      if (broad?.products?.length) {
        let text = `Couldn't find "${productName}" exactly. Did you mean:\n\n`;
        broad.products.forEach((p, i) => { const { line } = priceStock(p); text += `${i+1}. ${p.name} – ${line}\n`; });
        text += '\nWhich one?';
        return { type: 'replace', text };
      }
    } catch (_) {}
    return { type: 'replace', text: `We don't have "${productName}" right now. Want to see everything we carry?` };
  }

  // ── We have the product — build the rich response ────────────────────────

  const hasVariants   = product.variants?.length > 0;
  const hasVariations = product.variations?.length > 0;

  // Display price: variants have absolute prices → use min variant price
  // variations-only → use min price_adjustment; simple product → use product.price
  const { line: priceStr, stockInfo } = buildPriceStockDisplay(product);

  // Build options/variants text — grouped for readability
  const variationsText = buildVariationsText(product);

  if (!share_media) {
    return { type: 'product_card', images: [], variationsText: variationsText || null };
  }

  const isValidUrl = u => u && !u.startsWith('data:') && u.startsWith('http');
  const imagesToSend = [];

  // normalise optionRequested for case-insensitive matching
  const reqOpt = optionRequested?.trim().toLowerCase() || null;

  // Helper: does an option value match what was requested?
  const matchesRequest = o => {
    if (!reqOpt) return true; // no filter — include everything
    const val = (o.option_display_name || o.option_value || '').toLowerCase();
    return val === reqOpt || val.includes(reqOpt) || reqOpt.includes(val);
  };

  if (hasVariants && product.variants.length) {
    // Product has explicit SKU combos (e.g. Nike Black+42, Nike White+44)
    // If a specific option was requested, only show images for matching variants.
    // If no specific option was requested, show one image per primary-option group.

    if (reqOpt) {
      // Filter to variants that contain the requested option in ANY dimension
      const matched = product.variants.filter(v =>
        v.options.some(o => matchesRequest(o))
      );
      const src = matched.length ? matched : product.variants; // fallback to all if nothing matched

      // Collect distinct image URLs from matching variants, prefer variation-option images
      const seenUrl = new Set();
      for (const v of src) {
        // Find the variation-group image for the requested option if possible
        let imgUrl = null;
        for (const opt of v.options) {
          if (!matchesRequest(opt)) continue;
          // Look up the variation option that has an image
          for (const vg of (product.variations || [])) {
            const vo = vg.options?.find(x =>
              (x.option_display_name || x.option_value)?.toLowerCase() === (opt.option_display_name || opt.option_value)?.toLowerCase()
            );
            if (vo && isValidUrl(vo.image_url)) { imgUrl = vo.image_url; break; }
          }
          if (imgUrl) break;
        }
        if (!imgUrl) imgUrl = pickProductImageUrl(product, base);
        if (!imgUrl || seenUrl.has(imgUrl)) continue;
        seenUrl.add(imgUrl);

        const label = v.options.map(o => o.option_display_name || o.option_value).join(' / ');
        const vPrice = v.price ? ` — ${fmtN(v.price)}` : '';
        const vStock = v.stock != null ? ` (${v.stock} left)` : '';
        imagesToSend.push({ url: imgUrl, caption: `${product.name} — ${label}${vPrice}${vStock}` });
        if (imagesToSend.length >= 5) break;
      }
    } else {
      // No specific option requested — one image per primary-option group (e.g. one per colour)
      const primaryVariation = product.variations?.[0]; // first variation group = primary
      const seenPrimary = new Set();
      for (const v of product.variants) {
        const primary = v.options?.[0]?.option_display_name || v.options?.[0]?.option_value || '';
        if (seenPrimary.has(primary)) continue;
        seenPrimary.add(primary);

        // Image: check primary variation-option first, then product image
        const primaryOpt = primaryVariation?.options?.find(o =>
          (o.option_display_name || o.option_value) === primary
        );
        const imgUrl = isValidUrl(primaryOpt?.image_url)
          ? primaryOpt.image_url
          : pickProductImageUrl(product, base);
        if (!imgUrl) continue;

        const siblingLabels = product.variants
          .filter(x => (x.options?.[0]?.option_display_name || x.options?.[0]?.option_value) === primary)
          .map(x => x.options.slice(1).map(o => o.option_display_name || o.option_value).join('+'))
          .filter(Boolean).join(' / ');
        const caption = siblingLabels
          ? `${product.name} — ${primary} | ${siblingLabels} | ${priceStr}`
          : `${product.name} — ${primary} | ${priceStr}`;
        imagesToSend.push({ url: imgUrl, caption });
        if (imagesToSend.length >= 5) break;
      }
    }

  } else if (hasVariations) {
    // Product has variation option groups but no explicit SKU combos
    // If a specific option was requested, send only that option's image.
    // Otherwise send images for all available options that have one.
    for (const vg of product.variations) {
      const opts = (vg.options || []).filter(o =>
        o.is_available !== false && isValidUrl(o.image_url) && matchesRequest(o)
      );
      for (const o of opts) {
        const optPrice = parseFloat(o.price_adjustment || o.price);
        const priceDisplay = !isNaN(optPrice) && optPrice > 0 ? ` — ${fmtN(optPrice)}` : '';
        const stockDisplay = o.stock != null ? ` (${o.stock} left)` : '';
        imagesToSend.push({
          url: o.image_url,
          caption: `${product.name} — ${o.option_display_name || o.option_value}${priceDisplay}${stockDisplay}`,
        });
        if (imagesToSend.length >= 5) break;
      }
      if (imagesToSend.length >= 5) break;
    }
    // Fall back to main product image if no variation-option images exist
    if (!imagesToSend.length) {
      const imgUrl = pickProductImageUrl(product, base);
      if (imgUrl) imagesToSend.push({
        url: imgUrl,
        caption: `${product.name} — ${priceStr}${stockInfo ? ` | ${stockInfo}` : ''}`,
      });
    }

  } else {
    // Simple product — one image
    const imgUrl = pickProductImageUrl(product, base);
    if (imgUrl) imagesToSend.push({
      url: imgUrl,
      caption: `${product.name} — ${priceStr}${stockInfo ? ` | ${stockInfo}` : ''}`,
    });
  }

  return {
    type: 'product_card',
    images: imagesToSend,
    variationsText: variationsText || null,
  };
}

// ── Show variations ───────────────────────────────────────────────────────────
async function handleShowVariations(tenantId, subscriptionPlan, productName, skipIfAlreadyInReply = false, prefetchedProducts = null) {
  if (!productName) return null;
  if (skipIfAlreadyInReply) return null;

  // Use pre-fetched product if available
  let p = null;
  if (prefetchedProducts?.length) {
    p = prefetchedProducts.find(x => x.name?.toLowerCase().includes(productName.toLowerCase()))
      || prefetchedProducts[0];
  }

  if (!p) {
    const result = await backendApi.listProducts(tenantId, subscriptionPlan, { search: productName, limit: 5 })
      .catch(e => { console.error('[showVariations] listProducts error:', e.message); return null; });
    if (!result?.products?.length) return null;
    p = result.products.find(x => x.name?.toLowerCase().includes(productName.toLowerCase()))
      || result.products[0];
  }

  if (!p.variants?.length && !p.variations?.length) return null;

  const text = buildVariationsText(p);
  if (!text) return null;
  return { type: 'soft_replace', text };
}

// ── Order creation ────────────────────────────────────────────────────────────
async function handleOrderCreation({ tenantId, subscriptionPlan, defaultOnlineStoreId,
    message, conversationHistory, customerPhone, orderDataFromGemini, pendingOrder,
    paymentInstructionType, paypalEmail, bankAccountName, bankName,
    bankAccountNumber, bankCode, paymentInstructions, messageId }) {

    if (!defaultOnlineStoreId) {
    return { type: 'replace', text: "This store isn't set up for online orders yet. Reach out to the merchant directly." };
  }

  // Parse order details from Gemini's structured output or extract from conversation
  let details;
  if (orderDataFromGemini?.product_name) {
    details = {
      items: [{
        product_name:     orderDataFromGemini.product_name,
        product_id:       orderDataFromGemini.product_id      || null,
        variant_id:       orderDataFromGemini.variant_id      || null,
        // selected_options: Gemini passes "Black / 42" so we can resolve the correct variant
        selected_options: orderDataFromGemini.selected_options || null,
        quantity:         orderDataFromGemini.quantity         || 1,
      }],
      customer_name:    orderDataFromGemini.customer_name    || null,
      customer_phone:   orderDataFromGemini.customer_phone   || customerPhone,
      customer_email:   orderDataFromGemini.customer_email   || null,
      shipping_address: orderDataFromGemini.customer_address || null,
      ready_to_create: !!(
        orderDataFromGemini.product_name &&
        orderDataFromGemini.customer_name &&
        (orderDataFromGemini.customer_phone || customerPhone) &&
        orderDataFromGemini.customer_address
      ),
    };
  } else {
    details = await ai.extractOrderDetails(message, conversationHistory, pendingOrder);
  }

  if (!details) return { type: 'replace', text: "What would you like to order?" };

  if (!details.ready_to_create) {
    return {
      type: 'order_pending',
      pending_order: {
        items:            details.items || [],
        customer_name:    details.customer_name,
        customer_phone:   details.customer_phone || customerPhone,
        customer_email:   details.customer_email,
        shipping_address: details.shipping_address,
      },
    };
  }

  // Validate each item and resolve product_id + variant_id
  // Strategy: try checkProduct first. If it fails (server error), fall back to
  // listProducts search. Never block an order due to a backend endpoint failure.
  const validItems = [];
  for (const item of details.items) {
    let p = null;

    // Attempt 1: checkProduct (may fail if plan is 'free' or endpoint is down)
    const check = await backendApi.checkProduct(tenantId, item.product_name, subscriptionPlan)
      .catch(() => null);

    if (check?.exists && check.product) {
      p = check.product;
    } else if (!check || !check.success) {
      // checkProduct failed (server error) — fall back to listProducts search
      console.warn(`[order] checkProduct failed for "${item.product_name}" — trying listProducts fallback`);
      const fallback = await backendApi.listProducts(tenantId, subscriptionPlan, {
        search: item.product_name, limit: 5,
      }).catch(() => null);

      if (fallback?.products?.length) {
        p = fallback.products.find(x =>
          x.name?.toLowerCase() === item.product_name.toLowerCase()
        ) || fallback.products.find(x =>
          x.name?.toLowerCase().includes(item.product_name.toLowerCase())
        ) || fallback.products[0];
      }
    }
    // check returned success:false (product genuinely not found)
    // p remains null → inform customer

    if (!p) {
      return { type: 'replace', text: `"${item.product_name}" isn't available right now. Want to see what we have?` };
    }

      const qty = item.quantity || 1;
    if (p.stock != null && p.stock < qty) {
      return { type: 'replace', text: `We only have ${p.stock} of the ${p.name} left — you wanted ${qty}. Want to adjust?` };
    }

    // Resolve variant_id — try multiple sources in priority order:
    // 1. Explicit variant_id from Gemini (rare but possible)
    // 2. selected_options string "Black / 42" — match against variant combos
    // 3. item.option_requested (from query_inventory context)
    let resolvedVariantId = item.variant_id || null;

    if (!resolvedVariantId && p.variants?.length) {
      const needle = (item.selected_options || item.option_requested || '').toLowerCase().trim();

      if (needle) {
        // Parse "Black / 42" into individual tokens and find the variant that matches ALL of them
        const tokens = needle.split(/[\s/,+]+/).map(t => t.trim()).filter(Boolean);

        resolvedVariantId = p.variants.find(v =>
          tokens.every(token =>
            v.options?.some(o =>
              (o.option_display_name || o.option_value || '').toLowerCase().includes(token)
            )
          )
        )?.id || null;

        // Fallback: match any single token (e.g. just "Black" without size)
        if (!resolvedVariantId) {
          resolvedVariantId = p.variants.find(v =>
            tokens.some(token =>
              v.options?.some(o =>
                (o.option_display_name || o.option_value || '').toLowerCase() === token
              )
            )
          )?.id || null;
        }
      }
    }

    // Resolve unit price — must never be 0 or null
    // Priority: matched variant price → cheapest variant price → variation min price → product base price
    let unitPrice = null;

    if (resolvedVariantId) {
      unitPrice = p.variants?.find(v => v.id === resolvedVariantId)?.price ?? null;
    }

    if (!unitPrice || parseFloat(unitPrice) <= 0) {
      if (p.variants?.length) {
        // Product is variant-only (p.price is null) — use cheapest variant
        const prices = p.variants.map(v => parseFloat(v.price)).filter(n => !isNaN(n) && n > 0);
        unitPrice = prices.length ? Math.min(...prices) : null;
      } else if (p.variations?.length) {
        // Variations with price_adjustment — find minimum
        let min = null;
        for (const v of p.variations) {
          for (const o of (v.options || [])) {
            const n = parseFloat(o.price_adjustment || o.price);
            if (!isNaN(n) && n > 0 && (min === null || n < min)) min = n;
          }
        }
        unitPrice = min;
      } else {
        unitPrice = p.price;
      }
    }

    const finalUnitPrice = parseFloat(unitPrice);
    if (!finalUnitPrice || finalUnitPrice <= 0) {
      console.error(`[order] Could not resolve price for ${p.name} (variant=${resolvedVariantId})`);
      return { type: 'replace', text: `There was an issue with the price for ${p.name}. Please contact the store directly.` };
    }
    validItems.push({
      product_id:   p.id,
      variant_id:   resolvedVariantId,
        product_name: p.name,
      quantity:     qty,
      price:        finalUnitPrice,
      });
    }

  // Create the order (idempotent) — use inbound WhatsApp messageId as idempotency key
    const orderResult = await backendApi.createOrder(tenantId, {
      online_store_id: defaultOnlineStoreId,
    items: validItems,
      customer_info: {
      name:             details.customer_name    || 'WhatsApp Customer',
      email:            details.customer_email   || '',
      phone:            details.customer_phone   || customerPhone,
      shipping_address: details.shipping_address || '',
    },
    idempotency_key: messageId || undefined,
  });

  if (!orderResult.success) {
    return { type: 'replace', text: "Ran into an issue placing the order. Give it another try or contact us directly." };
  }

  const o = orderResult.order;
  const orderId     = o?.id;
  const orderNumber = o?.order_number || `#${orderId}`;
  const totalRaw    = o?.total != null ? parseFloat(o.total) : null;
  const total       = totalRaw != null ? fmtN(totalRaw) : null;

  // ── Paystack: generate a proper payment link with full metadata ──────────────
  // When merchant has configured Paystack, generate a fresh payment link via the
  // initialize-payment-link endpoint instead of using the generic order paymentLink.
  // This embeds all order/item metadata into the Paystack transaction.
  const isPaystack = (paymentInstructionType || '').toLowerCase() === 'paystack';
  let resolvedPaymentLink = orderResult.paymentLink || null;

  if (isPaystack && orderId) {
    const customerEmail = details.customer_email || `${(details.customer_phone || customerPhone).replace(/[^\d]/g, '')}@wa.mycroshop.local`;
    const amountKobo = totalRaw ? Math.round(totalRaw * 100) : 0; // Paystack uses kobo (smallest unit)

    const paymentLinkResult = await backendApi.initializePaymentLink({
      tenant_id:          tenantId,
      amount:             totalRaw || 0,
      email:              customerEmail,
      name:               details.customer_name || 'WhatsApp Customer',
      currency:           'NGN',
      customer_phone:     (details.customer_phone || customerPhone).replace(/[^\d+]/g, ''),
      whatsapp_message_id: messageId || null,
      metadata: {
        source:           'whatsapp_ai',
        channel:          'whatsapp',
        flow:             'product_order',
        tenant_id:        tenantId,
        order_id:         orderId,
        online_store_id:  defaultOnlineStoreId,
        customer_name:    details.customer_name || 'WhatsApp Customer',
        customer_phone:   (details.customer_phone || customerPhone).replace(/[^\d+]/g, ''),
        customer_email:   details.customer_email || customerEmail,
        shipping_address: details.shipping_address || '',
        items: validItems.map(i => ({
          product_id:   i.product_id,
          product_name: i.product_name,
          quantity:     i.quantity,
          unit_price:   i.price,
          ...(i.variant_id ? { variant_id: i.variant_id } : {}),
        })),
        subtotal: totalRaw || 0,
        delivery_fee: 0,
        discount: 0,
        total: totalRaw || 0,
        payment_context: {
          origin:              'ai_sales_agent',
          whatsapp_message_id: messageId || null,
          initiated_at:        new Date().toISOString(),
        },
      },
    }).catch(e => { console.error('[order] initializePaymentLink failed:', e.message); return null; });

    if (paymentLinkResult?.payment_link) {
      resolvedPaymentLink = paymentLinkResult.payment_link;
      console.log(`[order] Paystack link generated for order ${orderId}: ${resolvedPaymentLink}`);
    } else {
      console.warn(`[order] Paystack link generation failed for order ${orderId} — falling back to generic link`);
    }
  }

  // Build payment instructions based on merchant's configured payment method
  const payInstructions = buildPaymentInstructions({
    paymentInstructionType, paypalEmail,
    bankAccountName, bankName, bankAccountNumber,
    paymentInstructions, total,
    paymentLink: resolvedPaymentLink,
  });

  // Compose the order confirmation + payment instruction message
  let itemsList = (o?.OnlineStoreOrderItems || validItems).map(i =>
    `• ${i.product_name}${i.quantity > 1 ? ` x${i.quantity}` : ''} — ${fmtN(i.unit_price || i.price)}`
  ).join('\n');

  let msg = `✅ Order placed!\n\nOrder ${orderNumber}\n${itemsList}`;
  if (total) msg += `\n\nTotal: *${total}*`;
  msg += `\n\n${payInstructions}`;
  // For bank transfer: ask for receipt. For Paystack: no receipt needed (payment is confirmed automatically).
  if (!isPaystack) {
    msg += `\n\nOnce you've paid, *send me a photo of your receipt* and I'll notify the store right away. 📸`;
  }

  return {
    type: 'replace',
    text: msg,
    // For Paystack: payment is handled online — no receipt needed, set to a non-awaiting state
    new_order_state: isPaystack ? 'idle' : 'awaiting_payment',
    new_pending_order: isPaystack ? null : {
      ...(pendingOrder || {}),
      order_id:     orderId,
      order_number: orderNumber,
      total,
      items:        validItems,
      customer_name:   details.customer_name,
      customer_phone:  details.customer_phone || customerPhone,
      shipping_address: details.shipping_address,
    },
  };
}

/**
 * Build the full payment message for a confirmed booking, generating a Paystack link if configured.
 * Shared by both the slot-tap path and the AI-driven book_service path.
 */
async function buildBookingPaymentMessage({
  tenantId, bookingId, serviceTitle, scheduledAt, dateLabel, timeLabel,
  customerName, customerPhone, customerEmail,
  service_id,
  paymentInstructionType, paypalEmail, bankAccountName, bankName,
  bankAccountNumber, paymentInstructions, bookingData,
}) {
  const isPaystack = (paymentInstructionType || '').toLowerCase() === 'paystack';
  let resolvedPaymentLink = null;

  if (isPaystack && bookingId) {
    const safeEmail = customerEmail || `${(customerPhone || '').replace(/[^\d]/g, '')}@wa.mycroshop.local`;
    const result = await backendApi.initializePaymentLink({
      tenant_id:          tenantId,
      amount:             bookingData?.price != null ? parseFloat(bookingData.price) : 0,
      email:              safeEmail,
      name:               customerName || 'WhatsApp Customer',
      currency:           'NGN',
      customer_phone:     (customerPhone || '').replace(/[^\d+]/g, ''),
      whatsapp_message_id: null,
      metadata: {
        source:         'whatsapp_ai',
        channel:        'whatsapp',
        flow:           'service_booking',
        tenant_id:      tenantId,
        booking_id:     bookingId,
        service_id:     service_id,
        service_title:  serviceTitle,
        scheduled_at:   scheduledAt,
        timezone:       'Africa/Lagos',
        location_type:  bookingData?.location_type || 'in_person',
        customer_name:  customerName || 'WhatsApp Customer',
        customer_phone: (customerPhone || '').replace(/[^\d+]/g, ''),
        customer_email: customerEmail || safeEmail,
        payment_context: { origin: 'ai_sales_agent', initiated_at: new Date().toISOString() },
      },
    }).catch(e => { console.error('[booking] initializePaymentLink failed:', e.message); return null; });

    if (result?.payment_link) {
      resolvedPaymentLink = result.payment_link;
      console.log(`[booking] Paystack link generated for booking ${bookingId}`);
    }
  }

  const payInstructions = buildPaymentInstructions({
    paymentInstructionType, paypalEmail,
    bankAccountName, bankName, bankAccountNumber,
    paymentInstructions, total: null, paymentLink: resolvedPaymentLink,
  });

  const lines = [
    `✅ *Booking Confirmed!*`,
    ``,
    `Service: *${serviceTitle}*`,
    `Date & Time: *${dateLabel} at ${timeLabel}*`,
    ``,
    payInstructions,
  ];
  if (!isPaystack) {
    lines.push(``, `Once you've paid, *send me a photo of your receipt* and I'll notify the store right away. 📸`);
  }

  return {
    text: lines.join('\n'),
    isPaystack,
    resolvedPaymentLink,
  };
}

// ── Refund request handler ────────────────────────────────────────────────────
// Called when AI emits a 'request_refund' action with extracted refund details.
async function handleRefundRequest({
  tenantId, customerPhone,
  customerName, customerEmail,
  orderId, receiptId, reason, details: refundDetails,
}) {
  const log = (tag, ...a) => console.log(`[refund:${tag}]`, ...a);

  if (!orderId && !receiptId) {
    log('skip', 'No order_id or receipt_id — cannot submit refund');
    return {
      type: 'replace',
      text: "To process a refund I'll need your order number or receipt ID. Could you share that?",
    };
  }

  if (!reason) {
    return {
      type: 'replace',
      text: "What's the reason for the refund? A quick description helps the store process it faster.",
    };
  }

  log('submit', `order=${orderId} receipt=${receiptId} reason="${reason}"`);

  const result = await backendApi.submitRefundRequest({
    tenant_id:      tenantId,
    customer_name:  customerName  || 'Unknown',
    customer_phone: customerPhone,
    customer_email: customerEmail || '',
    order_id:       orderId       || undefined,
    receipt_id:     receiptId     || undefined,
    source_channel: 'whatsapp_ai',
    reason:         reason,
    details:        refundDetails || '',
  }).catch(e => { console.error('[refund] submitRefundRequest failed:', e.message); return null; });

  if (result?.success) {
    log('done', 'Refund request submitted');
    return {
      type: 'replace',
      text: [
        `✅ Your refund request has been submitted.`,
        ``,
        `*Order/Receipt:* ${orderId ? `#${orderId}` : receiptId}`,
        `*Reason:* ${reason}`,
        ``,
        `The store will review it and get back to you here. This usually takes 1–3 business days.`,
      ].join('\n'),
    };
  } else {
    log('error', result?.message || 'unknown error');
    return {
      type: 'replace',
      text: `We couldn't submit your refund request right now. Please try again or contact the store directly.`,
    };
  }
}

/**
 * Build a human-readable payment instruction block based on merchant settings.
 */
function buildPaymentInstructions({ paymentInstructionType, paypalEmail, bankAccountName,
    bankName, bankAccountNumber, paymentInstructions, total, paymentLink }) {

  // Custom instructions from merchant take priority
  if (paymentInstructions?.trim()) {
    // Keep merchant custom text, but append bank details if present so customers still get account info.
    let custom = `*Payment Instructions:*\n${paymentInstructions.trim()}`;
    const hasAnyBank = !!(bankName || bankAccountName || bankAccountNumber);
    if (hasAnyBank && !/account\s*number|bank\s*:/i.test(paymentInstructions)) {
      custom += `\n\n*Bank Transfer:*`;
      if (bankName)          custom += `\nBank: ${bankName}`;
      if (bankAccountName)   custom += `\nAccount Name: ${bankAccountName}`;
      if (bankAccountNumber) custom += `\nAccount Number: *${bankAccountNumber}*`;
      if (total)             custom += `\nAmount: *${total}*`;
    }
    return custom;
  }

  const type = (paymentInstructionType || '').toLowerCase();
  const hasBankDetails = !!(bankAccountNumber || bankName || bankAccountName);
  const isBankLikeType =
    type === 'bank_transfer' ||
    type === 'bank' ||
    type === 'transfer' ||
    type.includes('bank') ||
    type.includes('transfer');

  if (type === 'paystack' && paymentLink) {
    return `*Pay online:*\n${paymentLink}\n\nOr tap the link above to pay securely with your card.`;
  }

  if (type === 'paypal' && paypalEmail) {
    return `*Pay via PayPal:*\nSend ${total || 'the total amount'} to: *${paypalEmail}*\nUse "Goods & Services" and add the order number as reference.`;
  }

  if (isBankLikeType && hasBankDetails) {
    let instr = `*Bank Transfer:*`;
    if (bankName)          instr += `\nBank: ${bankName}`;
    if (bankAccountName)   instr += `\nAccount Name: ${bankAccountName}`;
    if (bankAccountNumber) instr += `\nAccount Number: *${bankAccountNumber}*`;
    if (total)             instr += `\nAmount: *${total}*`;
    return instr;
  }

  // If no payment link exists but bank details exist, still show bank transfer details.
  if (!paymentLink && hasBankDetails) {
    let instr = `*Bank Transfer:*`;
    if (bankName)          instr += `\nBank: ${bankName}`;
    if (bankAccountName)   instr += `\nAccount Name: ${bankAccountName}`;
    if (bankAccountNumber) instr += `\nAccount Number: *${bankAccountNumber}*`;
    if (total)             instr += `\nAmount: *${total}*`;
    return instr;
  }

  if (paymentLink) {
    return `*Pay here:*\n${paymentLink}`;
  }

  return `Please send payment and share your receipt once done.`;
}

// ── Payment check ─────────────────────────────────────────────────────────────
async function handlePaymentCheck(tenantId, message) {
  const ref = extractPaymentRef(message);
  if (!ref) return { type: 'replace', text: "What's your payment reference? I'll verify it." };

  const result = await backendApi.verifyPayment(tenantId, ref);
  if (!result?.success) return { type: 'replace', text: "Couldn't look that up right now. Try again in a moment." };

  if (result.paid) {
    const txn = result.transaction;
    let msg = `✅ Payment confirmed!\n\nRef: ${txn?.reference || ref}\n`;
    if (txn?.amount) msg += `Amount: ${fmtN(txn.amount)}\n`;
    if (result.order?.id) msg += `Order #${result.order.id} is now being processed.`;
    return { type: 'replace', text: msg };
  }

  return { type: 'replace', text: `Payment for ref ${ref} hasn't come through yet. Complete the payment and try again.` };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Intent detection + helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Recent chat looks like service / availability / booking — not shopping for products. */
function conversationSuggestsActiveBookingContext(conversationHistory = []) {
  const recent = conversationHistory.slice(-12);
  let blob = '';
  for (const m of recent) {
    blob += `\n${String(m.text || m.content || '')}`;
  }
  const b = blob.toLowerCase();
  if (/\bavailability\s+for\b/.test(b)) return true;
  if (/\b(which|what)\s+date\b/.test(b)) return true;
  if (/\b(book|booking)\s+(an?\s+)?(appointment|service)\b/.test(b)) return true;
  if (/\btime\s*slot|\bschedule\b.*\bappointment\b/.test(b)) return true;
  if (/\byou(?:'re| are) asking about\b/.test(b)) return true;
  if (/\bthe\s+[''][^'']+['']\s+service\b/.test(b)) return true;
  // Match AI replies like: "You're asking about the 'Nail test' service. Which date..."
  if (/asking about the ['"][^'"]+['"]\s+service/i.test(b)) return true;
  // Match AI replies referencing a service and asking for a date
  if (/which date are you looking to book/i.test(b)) return true;
  if (/\bdate.*(?:you want|to book|for that|to schedule)\b/i.test(b)) return true;
  // Match when AI listed available time slots or dates
  if (/\bavailable\s+(dates?|times?|slots?)\b/.test(b)) return true;
  if (/\bpick\s+a\s+(date|time)\b/.test(b)) return true;
  return false;
}

/** "Let me see a list" with no product words — usually means dates/slots when booking context applies. */
function isVagueCatalogListRequest(message = '') {
  const t = String(message).toLowerCase().trim();
  if (t.length > 100) return false;
  if (!/\blist\b/.test(t)) return false;
  if (/\b(shoes|sneakers|boots|sandals|crocs|nike|product|products|item|items|catalogue|inventory|stock|pairs|sizes|colour|color|price)\b/.test(t)) {
    return false;
  }
  return /\b(let me see|can i see|i want to see|show me|give me|send)\s+(a\s+|the\s+)?list\b/.test(t)
    || /^\s*(show\s+(me\s+)?)?(the\s+)?list\s*\.?\s*$/i.test(t)
    || /^(yes|yeah|yep|ok|okay)\b.*\blist\b/.test(t);
}

function isVagueBookingListFollowUp(message = '') {
  const t = String(message).toLowerCase().trim();
  if (t.length > 80) return false;
  if (isVagueCatalogListRequest(message)) return true;
  if (/\b(show|see)\s+(me\s+)?(the\s+)?(dates|availability|times|slots|options)\b/.test(t)) return true;
  // "what dates", "which dates", "available dates" — no product words
  if (/\b(what|which|any)\s+dates?\b/.test(t) && !/\b(shoes|sneakers|product|item)\b/.test(t)) return true;
  // Short ambiguous "yes" / "ok, show me" after AI asked about dates
  if (/^(yes|yeah|sure|ok|okay|show me|go ahead|proceed)\s*\.?\s*$/.test(t)) return true;
  return false;
}

function shouldAttemptBookingAvailabilityPreempt(message = '') {
  const m = String(message || '').trim();
  if (!m) return false;
  if (extractServicePhraseForBooking(m)) return true;
  if (isBookingDateOrAvailabilityQuery(m) || shouldRouteListServicesToBooking(m)) return true;
  if (/\bavailability\b/i.test(m) && /\bfor\b/i.test(m)) return true;
  return false;
}

/**
 * Re-use service name from earlier user turns (e.g. "availability for nail test" → later "show the list").
 */
function pickServiceFromConversationHistory(services, conversationHistory = []) {
  if (!services?.length || !conversationHistory?.length) return null;
  const userMsgs = [...conversationHistory].filter(x => x.role === 'user').slice(-6).reverse();
  for (const um of userMsgs) {
    const txt = String(um.text || um.content || '');
    if (!txt.trim()) continue;
    const p = pickServiceFromUserMessage(services, txt);
    if (p) return p;
  }
  return null;
}

/**
 * Determine whether to pre-fetch inventory before calling Gemini.
 * Returns { needed: bool, search: string|null }
 *
 * We pre-fetch when the customer is asking about products so Gemini has
 * real data and can write a complete, accurate reply in one shot.
 */
function detectInventoryIntent(message, conversationHistory, orderState) {
  // Don't fetch during active order collection — it's just detail gathering
  if (orderState === 'collecting_details' || orderState === 'confirming') {
    return { needed: false, search: null };
  }

  const m = message.toLowerCase();

  // Booking/date/time-slot requests should not be handled as inventory.
  if (isBookingIntentMessage(message)) {
    return { needed: false, search: null };
  }

  // After discussing a service, "let me see a list" means dates/slots — not shoe catalog
  if (isVagueCatalogListRequest(message) && conversationSuggestsActiveBookingContext(conversationHistory)) {
    return { needed: false, search: null };
  }

  // Generic product/catalog queries
  const genericPatterns = [
    /\b(what.*you have|what.*you got|what.*you sell|your products|your catalog|your items|price list|send.*catalog|show.*products|show.*items|wetin.*you get|watin.*you get|what.*in stock|see.*products)\b/,
    /\b(catalog|inventory|list|browse)\b/,
  ];
  if (genericPatterns.some(p => p.test(m))) {
    return { needed: true, search: null }; // full catalog
  }

  // Specific category or product search
  // Key insight: strip color/attribute qualifiers before using as search term.
  // "sneakers touch of ash colors" → search "sneakers", note color=ash
  // "blue Air Force 1" → search "Air Force 1", note color=blue
  const colorWords = /\b(red|blue|green|black|white|grey|gray|ash|brown|pink|yellow|purple|orange|nude|beige|navy|cream|gold|silver|maroon|cyan|teal|olive|coral|mint|lavender|charcoal|khaki|tan|multicolor|multi)\b/gi;

  // Words that TERMINATE the product name — everything after these is not the product
  // e.g. "sneakers AND the variations" → stop at "and", searchTerm = "sneakers"
  const stopWords = /^(and|with|or|but|for|variations?|options?|sizes?|colors?|colours?|pictures?|photos?|images?|please|thanks?)$/i;
  // Words to skip entirely (articles, possessives that appear inside the product phrase)
  const skipTerms = /^(me|your|the|a|an|any|some|picture|photo|image|catalog|products|items|stuff|price|prices|touch|of|in|type|kind|style|color|colour|colors|colours)$/i;

  const specificPatterns = [
    /(?:can i see|show me|you have|do you have|got any|any|see|find|need|want|looking for)\s+(?:the\s+|some\s+|a\s+|your\s+)?([a-z][a-z0-9 ]{1,40}?)(?:\?|$|\.|please|,|\band\b)/i,
    /(?:how much is|price of|cost of|how much for)\s+(?:the\s+)?([a-z][a-z0-9 ]{1,40}?)(?:\?|$|\.)/i,
    /(?:picture|photo|image)s?\s+(?:of\s+)?(?:the\s+)?([a-z][a-z0-9 ]{1,40}?)(?:\?|$|\.)/i,
    /(?:i need|i want)\s+(?:the\s+|some\s+|a\s+)?([a-z][a-z0-9 ]{1,40}?)(?:\?|$|\.|,|please)/i,
  ];

  for (const p of specificPatterns) {
    const match = message.match(p);
    if (match?.[1]) {
      const raw = match[1].trim();
      // Strip color words first
      const decolored = raw.replace(colorWords, '').replace(/\s{2,}/g, ' ').trim();
      // Walk word by word — stop at the first stop word so "variations" never joins the search
      const words = [];
      for (const w of decolored.split(' ')) {
        if (stopWords.test(w)) break;
        if (!skipTerms.test(w)) words.push(w);
      }
      const searchTerm = words.join(' ').trim();

      if (searchTerm && searchTerm.length > 1) {
        const colorMatches = raw.match(colorWords);
        const colorHint = colorMatches ? colorMatches.join(', ') : null;
        // Flag if the message also explicitly asked for variations
        const wantsVariations = /\b(variation|option|size|color|colour)s?\b/i.test(message);
        return { needed: true, search: searchTerm, colorHint, wantsVariations };
      }
    }
  }

  // Price/availability/stock questions
  // Special case: "how much is the white" / "price of the black one"
  // The color IS the variation they're asking about — resolve product from history
  if (/\b(price|cost|how much|available|in stock|e dey|do you have|you get)\b/.test(m)) {
    const lastProduct = extractLastProduct(conversationHistory);
    // If asking about a color/variant with a known product in context, search that product
    const colorInQuery = message.match(colorWords);
    if (colorInQuery && lastProduct) {
      return { needed: true, search: lastProduct, colorHint: colorInQuery[0] };
    }
    return { needed: true, search: lastProduct || null };
  }

  // Picture requests — use conversation context to find what they mean
  if (/\b(picture|photo|image|pic)\b/.test(m)) {
    const lastProduct = extractLastProduct(conversationHistory);
    // If we know what product they're asking about from context,
    // return it as a targeted search so we only fetch that product
    // (not the whole catalog). Gemini will emit query_inventory, not list_inventory.
    return { needed: true, search: lastProduct, contextual: !!lastProduct };
  }

  return { needed: false, search: null };
}

function isBookingIntentMessage(message = '') {
  const m = String(message).toLowerCase();
  return /\b(book|booking|appointment|schedule|service|services|available date|available dates|what dates|which dates|time slot|timeslot|slot|slots|availability)\b/.test(m);
}

/**
 * Returns true when the customer is asking to PAY FOR / ORDER a physical product
 * they have been discussing — NOT to book a service.
 *
 * This prevents Gemini's list_services hallucination where "can I pay for the ones
 * I have chosen?" gets routed to a service listing instead of order collection.
 *
 * Signals we look for (any one is enough):
 *   1. Message contains payment/purchase words
 *   2. Recent conversation history shows product browsing (₦ prices, product names)
 *   3. Order state is collecting_details (mid-order) or idle after product discussion
 */
function isProductPurchasePaymentIntent(message = '', conversationHistory = [], orderState = 'idle') {
  const m = String(message).toLowerCase().trim();

  // Must contain a payment/purchase/checkout intent word
  const hasPurchaseIntent = /\b(pay|payment|checkout|order|buy|purchase|proceed|place.*order|ready to (pay|buy|order)|can i (pay|buy|order)|i want to (pay|buy|order)|for the ones|i.ve chosen|i have chosen|i selected|i picked)\b/i.test(m);
  if (!hasPurchaseIntent) return false;

  // If they explicitly say "book", "appointment", or "service" — it's a booking, not a purchase
  const hasBookingWord = /\b(book|appointment|service|session|schedule)\b/i.test(m);
  if (hasBookingWord) return false;

  // If order is being collected, it's definitely a product purchase
  if (orderState === 'collecting_details' || orderState === 'confirming') return true;

  // Check conversation history for product shopping signals (₦ prices, product names in AI replies)
  if (conversationHistory.length > 0) {
    const recentBlob = conversationHistory
      .slice(-10)
      .map(x => String(x.text || x.content || ''))
      .join(' ')
      .toLowerCase();

    // Recent conversation has prices — product browsing was happening
    if (recentBlob.includes('₦')) return true;
    // Recent conversation mentions shoes/products explicitly
    if (/\b(sneakers?|shoes?|loafers?|boots?|sandals?|clacks?|clogs?|crocs?|oxfords?|product|item|pairs?)\b/.test(recentBlob)) return true;
    // AI asked for address/name (order collection in progress)
    if (/\b(delivery address|your address|your name|phone number|what.s your name)\b/.test(recentBlob)) return true;
  }

  return false;
}

/** User is asking for dates/slots/availability — not a generic "list all services". */
function isBookingDateOrAvailabilityQuery(message = '') {
  const m = String(message).toLowerCase();
  return /\b(what dates|which dates|available dates|any dates|open dates|time slot|timeslot|time slots|availability|when can i|openings?|open slot|schedule)\b/.test(m);
}

/**
 * "I'd like to book [X]" / "dates for [X] service" — prefer booking handler over full service dump.
 */
function shouldRouteListServicesToBooking(message = '') {
  const m = String(message).toLowerCase();
  return /\b(book|booking|appointment|for your|for the|for my|dates for|availability for)\b/.test(m);
}

/** Pull service name from "availability for X", "see … for X", etc. */
function extractServicePhraseForBooking(message) {
  const raw = String(message || '').trim();
  if (!raw) return null;
  const pats = [
    /\bsee\s+(?:the\s+)?availability\s+for\s+(.+?)(?:\s+on\b|\?|$|\.(?:\s|$))/i,
    /\bavailability\s+for\s+(.+?)(?:\s+on\b|\?|$|\.(?:\s|$))/i,
    /\bavailability\s+of\s+(.+?)(?:\s+on\b|\?|$|\.(?:\s|$))/i,
    /\bopenings?\s+for\s+(.+?)(?:\s+on\b|\?|$|\.(?:\s|$))/i,
    /\bdates?\s+for\s+(.+?)(?:\s+on\b|\?|$|\.(?:\s|$))/i,
    /\bbook(?:ing)?\s+(?:a\s+|an\s+)?(.+?)(?:\s+on\b|\s+for\b|\?|$)/i,
    /\bfor\s+my\s+(.+?)\s+(?:appointment|booking)\b/i,
  ];
  for (const p of pats) {
    const m = raw.match(p);
    if (m && m[1]) {
      let s = m[1].trim().replace(/\s+/g, ' ');
      s = s.replace(/^(the|a|an)\s+/i, '').trim();
      if (s.length >= 2) return s;
    }
  }
  return null;
}

function formatShortDateForWhatsappList(ymd) {
  const d = new Date(String(ymd).slice(0, 10) + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return String(ymd).slice(0, 10).slice(0, 24);
  const w = d.toLocaleDateString('en-US', { weekday: 'short' });
  const rest = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const out = `${w} ${rest}`;
  return out.length > 24 ? out.slice(0, 24) : out;
}

/**
 * Match user text to a StoreService title.
 * Prefers exact / word-boundary prefix over longer titles (e.g. "Nail test" vs "Nail test566").
 */
function pickServiceFromUserMessage(services, message) {
  const lower = String(message || '').toLowerCase();
  if (!services?.length) return null;
  const phrase = (extractServicePhraseForBooking(message) || '').toLowerCase().trim();

  function rank(s) {
    const t = (s.service_title || '').toLowerCase().trim();
    if (!t) return null;
    if (phrase) {
      if (t === phrase) return { score: 100, len: t.length };
      const tNoDig = t.replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim();
      if (phrase === tNoDig) return { score: 85, len: t.length };
      if (t.startsWith(phrase) && (t.length === phrase.length || t[phrase.length] === ' ')) {
        return { score: 80, len: t.length };
      }
      if (t.startsWith(phrase)) return { score: 50, len: t.length };
      if (t.includes(phrase)) return { score: 35, len: t.length };
    }
    if (lower.includes(t)) return { score: 40, len: t.length };
    const tNoDigits = t.replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim();
    if (tNoDigits.length > 3 && lower.includes(tNoDigits)) return { score: 25, len: t.length };
    return null;
  }

  let best = null;
  let bestScore = -1;
  let bestLen = Infinity;
  for (const s of services) {
    const r = rank(s);
    if (!r) continue;
    if (r.score > bestScore || (r.score === bestScore && r.len < bestLen)) {
      bestScore = r.score;
      bestLen = r.len;
      best = s;
    }
  }
  if (best) return best;

  const msgTokens = lower.split(/[^a-z0-9]+/).filter(w => w.length > 2);
  let fuzzy = null;
  let bestOverlap = 0;
  for (const s of services) {
    const t = (s.service_title || '').toLowerCase();
    const titleTokens = t.split(/[^a-z0-9]+/).filter(w => w.length > 2);
    const overlap = msgTokens.filter(w => titleTokens.some(tt => tt.includes(w) || w.includes(tt))).length;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      fuzzy = s;
    }
  }
  return bestOverlap >= 2 ? fuzzy : null;
}

function extractDateFromMessage(message = '') {
  const text = String(message).trim();

  // Helper to format a Date object as YYYY-MM-DD
  const fmt = d => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const now = new Date();
  const todayStr = fmt(now);

  // ISO date: 2026-03-24
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso?.[1]) return iso[1];

  // Relative words: today, tomorrow, day after tomorrow
  const lower = text.toLowerCase();
  if (/\btoday\b/.test(lower)) return todayStr;
  if (/\btomorrow\b/.test(lower)) {
    const d = new Date(now); d.setDate(d.getDate() + 1); return fmt(d);
  }
  if (/\bday after tomorrow\b/.test(lower)) {
    const d = new Date(now); d.setDate(d.getDate() + 2); return fmt(d);
  }

  // "next monday", "this friday", etc.
  const weekdays = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const nextDayMatch = lower.match(/\b(?:next|this)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (nextDayMatch) {
    const targetDay = weekdays.indexOf(nextDayMatch[1]);
    const d = new Date(now);
    const diff = (targetDay - d.getDay() + 7) % 7 || 7; // always go forward
    d.setDate(d.getDate() + diff);
    return fmt(d);
  }

  // "on monday", "monday" standalone — nearest upcoming occurrence
  const plainDayMatch = lower.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (plainDayMatch) {
    const targetDay = weekdays.indexOf(plainDayMatch[1]);
    const d = new Date(now);
    const diff = (targetDay - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + diff);
    return fmt(d);
  }

  // "March 24", "24 March", "March 24th"
  const monthDay = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i)
    || text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i);
  if (monthDay) {
    // figure out which capture is month vs day
    const isMonthFirst = /^[a-z]/i.test(monthDay[1]);
    const monthStr = isMonthFirst ? monthDay[1] : monthDay[2];
    const dayNum   = isMonthFirst ? monthDay[2] : monthDay[1];
    let year = now.getFullYear();
    const candidate = new Date(`${monthStr} ${dayNum}, ${year}`);
    // If that date has already passed this year, assume next year
    if (!Number.isNaN(candidate.getTime())) {
      if (candidate < now) candidate.setFullYear(year + 1);
      return fmt(candidate);
    }
  }

  return null;
}

/** Format products as readable text for prompt injection into Gemini */
function formatProductsForPrompt(products) {
  return products.slice(0, 20).map((p, i) => {
    const { line } = priceStock(p);
    let entry = `${i + 1}. ${p.name} – ${line}`;
    if (p.variants?.length) {
      // Compact grouped summary: "Black: 42/43 · White: 44/45"
      const summary = buildVariantSummary(p.variants);
      if (summary) entry += ` | ${summary}`;
    } else if (p.variations?.length) {
      // Show option group names only: "Color: Red/Blue · Size: 42/43"
      const parts = p.variations.map(v => {
        const opts = (v.options || []).filter(o => o.is_available !== false)
          .map(o => o.option_display_name || o.option_value).join('/');
        return v.variation_name ? `${v.variation_name}: ${opts}` : opts;
      }).filter(Boolean);
      if (parts.length) entry += ` | ${parts.join(' · ')}`;
    }
    return entry;
  }).join('\n');
}

/**
 * Build a compact variant summary for the Gemini prompt.
 * Groups variants by their first-option value (usually Color) and lists sizes.
 * e.g. "Black: 42, 43 · White: 44, 45"
 */
function buildVariantSummary(variants) {
  if (!variants?.length) return '';
  // Group by first option label
  const groups = {};
  for (const v of variants) {
    if (!v.options?.length) continue;
    const key   = v.options[0].option_display_name || v.options[0].option_value;
    const rest  = v.options.slice(1).map(o => o.option_display_name || o.option_value).join('+');
    const label = rest || `₦${v.price}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(label);
  }
  return Object.entries(groups).map(([k, vs]) => `${k}: ${vs.join('/')}`).join(' · ');
}

/**
 * buildPriceStockDisplay — returns { line, stockInfo } for a product card heading.
 * Uses variant prices when available (most accurate), falls back to variations/simple.
 */
function buildPriceStockDisplay(p) {
  if (p.variants?.length) {
    const prices = p.variants.map(v => parseFloat(v.price)).filter(n => !isNaN(n));
    const total  = p.variants.reduce((s, v) => s + Number(v.stock || 0), 0);
    const min    = prices.length ? Math.min(...prices) : null;
    const max    = prices.length ? Math.max(...prices) : null;
    const priceStr = min !== null
      ? (min === max ? fmtN(min) : `from ${fmtN(min)}`)
      : 'see options';
    return { line: priceStr, stockInfo: total > 0 ? `${total} in stock` : '' };
  }
  if (p.variations?.length) {
    let min = null, total = 0;
    for (const v of p.variations) {
      for (const o of (v.options || [])) {
        if (o.is_available === false) continue;
        const n = parseFloat(o.price_adjustment || o.price);
        if (!isNaN(n) && n > 0 && (min === null || n < min)) min = n;
        if (o.stock != null) total += Number(o.stock);
      }
    }
    return {
      line: min !== null ? `from ${fmtN(min)}` : 'see options',
      stockInfo: total > 0 ? `${total} in stock` : '',
    };
  }
  const price = parseFloat(p.price || 0);
  const stock = p.stock != null ? `${p.stock} in stock` : '';
  return { line: fmtN(price), stockInfo: stock };
}

/**
 * buildVariationsText — formats product options for display in a WhatsApp message.
 *
 * When variants[] exist (Color+Size combos with absolute prices):
 *   Groups by primary dimension (Color), lists secondary (Size) under each.
 *   Nike:
 *   *Black* — ₦30,000
 *     · Size 42 (5 left)
 *     · Size 43 (4 left)
 *   *White* — ₦30,500
 *     · Size 44 (3 left)
 *
 * When only variations[] exist (independent option groups):
 *   Color:
 *   • Red — ₦25 (30 left)
 *   • Blue — ₦27 (25 left)
 */
function buildVariationsText(p) {
  if (p.variants?.length) {
    // Group by primary option (first in options array, usually Color)
    const groups = new Map();
    for (const v of p.variants) {
      if (!v.options?.length) continue;
      const primary = v.options[0].option_display_name || v.options[0].option_value;
      const secondary = v.options.slice(1).map(o => o.option_display_name || o.option_value).join(' + ');
      if (!groups.has(primary)) groups.set(primary, { price: v.price, entries: [] });
      groups.get(primary).entries.push({
        label: secondary || null,
        stock: v.stock,
        price: v.price,
      });
    }

    let text = `${p.name}:\n\n`;
    for (const [primary, g] of groups) {
      // Show price per colour group (all sizes same price → show once)
      const prices = [...new Set(g.entries.map(e => e.price))];
      const priceStr = prices.length === 1 ? fmtN(prices[0]) : `from ${fmtN(Math.min(...prices))}`;
      text += `*${primary}* — ${priceStr}\n`;
      for (const e of g.entries) {
        if (e.label) {
          const stockStr = e.stock != null ? ` (${e.stock} left)` : '';
          text += `  · ${e.label}${stockStr}\n`;
        }
      }
      text += '\n';
    }
    return text.trimEnd() + '\n\nWhich works for you?';
  }

  if (p.variations?.length) {
    let text = '';
    for (const v of p.variations) {
      const opts = (v.options || []).filter(o => o.is_available !== false);
      if (!opts.length) continue;
      if (v.variation_name) text += `${v.variation_name}:\n`;
      for (const o of opts) {
        const optPrice  = parseFloat(o.price_adjustment || o.price);
        const basePrice = parseFloat(p.price);
        const finalPrice = !isNaN(optPrice) && optPrice > 0
          ? (o.price_adjustment != null && !isNaN(basePrice) && basePrice > 0
              ? basePrice + optPrice
              : optPrice)
          : (!isNaN(basePrice) && basePrice > 0 ? basePrice : null);
        const oStock = o.stock != null ? ` (${o.stock} left)` : '';
        const priceDisplay = finalPrice !== null ? ` — ${fmtN(finalPrice)}` : '';
        text += `• ${o.option_display_name || o.option_value}${priceDisplay}${oStock}\n`;
      }
      text += '\n';
    }
    return text.trim() ? text.trimEnd() + '\n\nWhich works for you?' : '';
  }

  return ''; // simple product — no options
}

/** Format price and stock for one product — handles variants, variations, and simple products */
function priceStock(p) {
  // Case 1: product has explicit variants (colour+size combos with absolute prices)
  if (p.variants?.length) {
    const prices = p.variants.map(v => parseFloat(v.price)).filter(n => !isNaN(n));
    const stocks = p.variants.map(v => Number(v.stock || 0));
    const min    = prices.length ? Math.min(...prices) : null;
    const total  = stocks.reduce((s, n) => s + n, 0);
    if (min !== null) return { line: `from ${fmtN(min)}${total > 0 ? ` (${total} in stock)` : ''}`, priceNum: min };
    return { line: 'multiple options', priceNum: 0 };
  }
  // Case 2: variations only (price_adjustment per option, no variant combos)
  if (p.variations?.length) {
    let min = null, total = 0;
    for (const v of p.variations) {
      for (const o of (v.options || [])) {
        const n = parseFloat(o.price_adjustment || o.price);
        if (!isNaN(n) && n > 0 && (min === null || n < min)) min = n;
        if (o.stock != null) total += Number(o.stock);
      }
    }
    if (min !== null) return { line: `from ${fmtN(min)}${total > 0 ? ` (${total} in stock)` : ''}`, priceNum: min };
    return { line: 'multiple options', priceNum: 0 };
  }
  // Case 3: simple product
  const price = parseFloat(p.price || 0);
  const stock = p.stock != null ? ` (${p.stock} in stock)` : '';
  return { line: `${fmtN(price)}${stock}`, priceNum: price };
}

/** Format Naira */
function fmtN(amount) {
  const n = Number(amount);
  if (isNaN(n)) return '₦0';
  return '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/**
 * Pick the best image URL for a product.
 * Priority: variant image → variation-option image → product image → null
 * Skips data: URIs — they cannot be sent as WhatsApp image URLs.
 */
function pickProductImageUrl(p, base) {
  const toUrl = url => {
    if (!url) return null;
    if (url.startsWith('data:')) return null;  // base64 inline — unusable as WhatsApp image URL
    if (url.startsWith('http')) return url;
    return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
  };

  // 1. First variant that has an image URL
  if (p.variants?.length) {
    for (const v of p.variants) {
      const u = toUrl(v.image_url);
      if (u) return u;
    }
  }

  // 2. First available variation option that has a real image URL
  if (p.variations?.length) {
    for (const v of p.variations) {
      for (const o of (v.options || [])) {
        if (o.is_available === false) continue;
        const u = toUrl(o.image_url);
        if (u) return u;
      }
    }
  }

  // 3. Main product image
  return toUrl(p.image_url || p.imageUrl);
}

/** Is this reply a placeholder that should be replaced by real data? */
function isPlaceholder(text) {
  const t = (text || '').trim();
  if (!t) return true; // empty = definitely a placeholder
  return /^(on it|sure|ok|checking|let me|pulling|one sec|hold on|gimme|alright|yeah|give me a sec|let me pull|hang on|just a)/i.test(t);
}

/**
 * Merge Gemini's intro with backend catalog data.
 *
 * Rules:
 * 1. If Gemini already has prices/products in its reply → it used the injected data → DON'T append (would duplicate)
 * 2. If Gemini wrote a short placeholder (1-2 lines, no prices) → append the real data
 * 3. If Gemini wrote a full multi-line reply without prices → trust it, don't append
 */
function mergeIntroAndData(geminiReply, dataText) {
  if (!geminiReply?.trim()) return dataText;
  if (!dataText?.trim())    return geminiReply;

  const reply = geminiReply.trim();

  // Gemini already wrote product data (has ₦ prices) — don't duplicate
  if (reply.includes('₦')) return reply;

  // Gemini already has a numbered list — don't duplicate
  if (/^\d+\.\s/m.test(reply)) return reply;

  // Gemini wrote a multi-line substantive reply — trust it
  if (reply.split('\n').length > 3) return reply;

  // Short intro or placeholder — append the catalog data below it
  return `${reply}\n\n${dataText.trim()}`;
}

/** Extract a product name from customer message */
function extractProductName(message) {
  if (!message) return null;
  const patterns = [
    /(?:price|cost|how much|available|in stock|do you have|show me|order|buy)\s+(?:of|for|is|the)?\s*(?:the\s+)?([A-Za-z0-9 ]{2,50}?)(?:\?|$|\.)/i,
    /(?:image|picture|photo)\s+of\s+(?:the\s+)?([A-Za-z0-9 ]{2,50}?)(?:\?|$|\.)/i,
  ];
  for (const p of patterns) {
    const m = message.match(p);
    if (m?.[1]?.trim().length > 1) return m[1].trim();
  }
  return null;
}

/** Get last product mentioned in conversation (for context-based requests) */
function extractLastProduct(history) {
  if (!Array.isArray(history)) return null;
  const recent = [...history].reverse().slice(0, 16);

  // PRIORITY 1: What did the USER explicitly ask about or mention wanting?
  // This is the most reliable signal — the customer's own words.
  for (const msg of recent) {
    if (msg.role !== 'user' || !msg.text) continue;
    const t = msg.text.toLowerCase();

    // "I'm looking for sneakers", "I want sneakers", "looking for X"
    const lookingFor = msg.text.match(/(?:looking for|want|need|interested in|after)\s+(?:a\s+|some\s+|the\s+)?([A-Za-z][A-Za-z0-9 ]{2,35}?)(?:\s+please|\?|$|\.)/i);
    if (lookingFor?.[1]) {
      const term = lookingFor[1].trim();
      // Skip generic words
      if (!/^(a|an|the|some|any|something|stuff|products?|items?|things?)$/i.test(term)) {
        return term;
      }
    }

    // Direct product name in a buy/order/price context
    const name = extractProductName(msg.text);
    if (name) return name;
  }

  // PRIORITY 2: What was the LAST specific product the assistant mentioned?
  // Only single-product mentions, not catalog lists.
  for (const msg of recent) {
    if (msg.role !== 'assistant' || !msg.text) continue;
    // Skip messages that look like catalog lists (have multiple numbered items)
    const numberedItems = (msg.text.match(/^\d+\./gm) || []).length;
    if (numberedItems > 1) continue; // this is a catalog, not a single product reference

    // Single numbered item (e.g. from a focused search result)
    const single = msg.text.match(/^1\.\s+([^–\-\n]{2,40}?)\s+[–\-]/m);
    if (single?.[1]) return single[1].trim();
  }

  return null;
}

/** Extract payment reference from message */
function extractPaymentRef(message) {
  const patterns = [
    /(?:reference|ref|txn|payment)[:\s#]+([A-Z0-9]{5,})/i,
    /\b([A-Z]{2,}[0-9]{4,})\b/,
    /\b([0-9]{6,}[A-Z]{2,})\b/i,
  ];
  for (const p of patterns) {
    const m = message.match(p);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

/** Fire-and-forget send that never crashes the main flow */
async function safeSend(phoneNumberId, to, accessToken, text) {
  if (!accessToken || !phoneNumberId || !to) return;
  await whatsapp.sendMessage(phoneNumberId, accessToken, to, text)
    .catch(e => console.error('[safeSend]', e.message));
}

module.exports = { processMessage };
