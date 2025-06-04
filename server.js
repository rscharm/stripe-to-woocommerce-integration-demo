const express = require('express');
const bodyParser = require('body-parser');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const WooCommerceRestApi = require('@woocommerce/woocommerce-rest-api').default;
const dotenv = require('dotenv');
const winston = require('winston');

dotenv.config();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple()
  }));
}

const WooCommerce = new WooCommerceRestApi({
  url: process.env.WOOCOMMERCE_STORE_URL,
  consumerKey: process.env.WOOCOMMERCE_CONSUMER_KEY,
  consumerSecret: process.env.WOOCOMMERCE_CONSUMER_SECRET,
  version: 'wc/v3'
});

const productMapping = {
  'price_123456789': {
    productId: 123,
    isSubscription: true,
    subscriptionPeriod: 'month'
  },
  'price_987654321': {
    productId: 456,
    isSubscription: false
  }
};

const app = express();

app.post('/stripe-webhook', 
  bodyParser.raw({ type: 'application/json' }), 
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      logger.error(`Webhook signature verification failed: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await handleCheckoutCompleted(event.data.object);
          break;
        case 'invoice.paid':
          await handleInvoicePaid(event.data.object);
          break;
        case 'customer.subscription.updated':
          await handleSubscriptionUpdated(event.data.object);
          break;
        case 'customer.subscription.deleted':
          await handleSubscriptionCancelled(event.data.object);
          break;
        default:
          logger.info(`Unhandled event type: ${event.type}`);
      }

      res.status(200).json({ received: true });
    } catch (err) {
      logger.error(`Error processing webhook: ${err.message}`, { error: err, event: event.type });
      res.status(500).json({ error: 'Failed to process webhook' });
    }
  }
);

async function handleCheckoutCompleted(session) {
  logger.info('Processing checkout.session.completed', { sessionId: session.id });
  
  try {
    const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
    
    const customer = await getOrCreateWooCustomer(session.customer_details);
    
    await createWooOrder(session, lineItems, customer.id);
    
    logger.info('Successfully processed checkout session', { sessionId: session.id });
  } catch (error) {
    logger.error('Failed to process checkout session', { 
      sessionId: session.id, 
      error: error.message 
    });
    throw error;
  }
}

async function handleInvoicePaid(invoice) {
  logger.info('Processing invoice.paid', { invoiceId: invoice.id });
  
  try {
    const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
    
    const stripeCustomer = await stripe.customers.retrieve(invoice.customer);
    
    const customer = await findWooCustomerByEmail(stripeCustomer.email);
    
    if (!customer) {
      throw new Error(`No WooCommerce customer found for email: ${stripeCustomer.email}`);
    }
    
    await processSubscriptionRenewal(invoice, subscription, customer.id);
    
    logger.info('Successfully processed invoice payment', { invoiceId: invoice.id });
  } catch (error) {
    logger.error('Failed to process invoice payment', { 
      invoiceId: invoice.id, 
      error: error.message 
    });
    throw error;
  }
}

async function handleSubscriptionUpdated(subscription) {
  logger.info('Processing subscription update', { subscriptionId: subscription.id });
  
  try {
    const stripeCustomer = await stripe.customers.retrieve(subscription.customer);
    
    const customer = await findWooCustomerByEmail(stripeCustomer.email);
    
    if (!customer) {
      throw new Error(`No WooCommerce customer found for email: ${stripeCustomer.email}`);
    }
    
    const wooSubscription = await findWooSubscription(subscription.id, customer.id);
    
    if (!wooSubscription) {
      logger.warn('No matching WooCommerce subscription found', { 
        stripeSubscriptionId: subscription.id 
      });
      return;
    }
    
    await updateWooSubscriptionStatus(wooSubscription.id, subscription.status);
    
    logger.info('Successfully updated subscription', { 
      subscriptionId: subscription.id,
      wooSubscriptionId: wooSubscription.id
    });
  } catch (error) {
    logger.error('Failed to update subscription', { 
      subscriptionId: subscription.id, 
      error: error.message 
    });
    throw error;
  }
}

async function handleSubscriptionCancelled(subscription) {
  logger.info('Processing subscription cancellation', { subscriptionId: subscription.id });
  
  try {
    const stripeCustomer = await stripe.customers.retrieve(subscription.customer);
    
    const customer = await findWooCustomerByEmail(stripeCustomer.email);
    
    if (!customer) {
      throw new Error(`No WooCommerce customer found for email: ${stripeCustomer.email}`);
    }
    
    const wooSubscription = await findWooSubscription(subscription.id, customer.id);
    
    if (!wooSubscription) {
      logger.warn('No matching WooCommerce subscription found', { 
        stripeSubscriptionId: subscription.id 
      });
      return;
    }
    
    await updateWooSubscriptionStatus(wooSubscription.id, 'cancelled');
    
    logger.info('Successfully cancelled subscription', { 
      subscriptionId: subscription.id,
      wooSubscriptionId: wooSubscription.id
    });
  } catch (error) {
    logger.error('Failed to cancel subscription', { 
      subscriptionId: subscription.id, 
      error: error.message 
    });
    throw error;
  }
}

async function getOrCreateWooCustomer(customerDetails) {
  if (!customerDetails || !customerDetails.email) {
    throw new Error('Customer email is required');
  }
  
  try {
    const existingCustomers = await WooCommerce.get('customers', {
      email: customerDetails.email
    });
    
    if (existingCustomers.data && existingCustomers.data.length > 0) {
      logger.info('Found existing customer', { email: customerDetails.email });
      return existingCustomers.data[0];
    }
    
    const customerData = {
      email: customerDetails.email,
      first_name: customerDetails.name ? customerDetails.name.split(' ')[0] : '',
      last_name: customerDetails.name ? customerDetails.name.split(' ').slice(1).join(' ') : '',
      billing: {
        first_name: customerDetails.name ? customerDetails.name.split(' ')[0] : '',
        last_name: customerDetails.name ? customerDetails.name.split(' ').slice(1).join(' ') : '',
        email: customerDetails.email,
        phone: customerDetails.phone || '',
        address_1: customerDetails.address ? customerDetails.address.line1 || '' : '',
        address_2: customerDetails.address ? customerDetails.address.line2 || '' : '',
        city: customerDetails.address ? customerDetails.address.city || '' : '',
        state: customerDetails.address ? customerDetails.address.state || '' : '',
        postcode: customerDetails.address ? customerDetails.address.postal_code || '' : '',
        country: customerDetails.address ? customerDetails.address.country || '' : ''
      },
      shipping: {
        first_name: customerDetails.name ? customerDetails.name.split(' ')[0] : '',
        last_name: customerDetails.name ? customerDetails.name.split(' ').slice(1).join(' ') : '',
        address_1: customerDetails.address ? customerDetails.address.line1 || '' : '',
        address_2: customerDetails.address ? customerDetails.address.line2 || '' : '',
        city: customerDetails.address ? customerDetails.address.city || '' : '',
        state: customerDetails.address ? customerDetails.address.state || '' : '',
        postcode: customerDetails.address ? customerDetails.address.postal_code || '' : '',
        country: customerDetails.address ? customerDetails.address.country || '' : ''
      }
    };
    
    const response = await WooCommerce.post('customers', customerData);
    logger.info('Created new customer', { email: customerDetails.email, id: response.data.id });
    return response.data;
  } catch (error) {
    logger.error('Error in getOrCreateWooCustomer', { 
      email: customerDetails.email, 
      error: error.message 
    });
    throw error;
  }
}

async function findWooCustomerByEmail(email) {
  try {
    const response = await WooCommerce.get('customers', { email });
    
    if (response.data && response.data.length > 0) {
      return response.data[0];
    }
    
    return null;
  } catch (error) {
    logger.error('Error finding customer by email', { email, error: error.message });
    throw error;
  }
}

async function createWooOrder(session, lineItems, customerId) {
  try {
    const wooLineItems = await Promise.all(lineItems.data.map(async (item) => {
      const mapping = productMapping[item.price.id];
      
      if (!mapping) {
        throw new Error(`No product mapping found for Stripe price ID: ${item.price.id}`);
      }
      
      return {
        product_id: mapping.productId,
        quantity: item.quantity
      };
    }));
    
    const orderData = {
      customer_id: customerId,
      payment_method: 'stripe',
      payment_method_title: 'Stripe',
      set_paid: true,
      billing: {
        first_name: session.customer_details.name ? session.customer_details.name.split(' ')[0] : '',
        last_name: session.customer_details.name ? session.customer_details.name.split(' ').slice(1).join(' ') : '',
        email: session.customer_details.email,
        phone: session.customer_details.phone || '',
        address_1: session.customer_details.address ? session.customer_details.address.line1 || '' : '',
        address_2: session.customer_details.address ? session.customer_details.address.line2 || '' : '',
        city: session.customer_details.address ? session.customer_details.address.city || '' : '',
        state: session.customer_details.address ? session.customer_details.address.state || '' : '',
        postcode: session.customer_details.address ? session.customer_details.address.postal_code || '' : '',
        country: session.customer_details.address ? session.customer_details.address.country || '' : ''
      },
      shipping: {
        first_name: session.customer_details.name ? session.customer_details.name.split(' ')[0] : '',
        last_name: session.customer_details.name ? session.customer_details.name.split(' ').slice(1).join(' ') : '',
        address_1: session.customer_details.address ? session.customer_details.address.line1 || '' : '',
        address_2: session.customer_details.address ? session.customer_details.address.line2 || '' : '',
        city: session.customer_details.address ? session.customer_details.address.city || '' : '',
        state: session.customer_details.address ? session.customer_details.address.state || '' : '',
        postcode: session.customer_details.address ? session.customer_details.address.postal_code || '' : '',
        country: session.customer_details.address ? session.customer_details.address.country || '' : ''
      },
      line_items: wooLineItems,
      meta_data: [
        {
          key: 'stripe_checkout_id',
          value: session.id
        }
      ]
    };
    
    const response = await WooCommerce.post('orders', orderData);
    logger.info('WooCommerce order created', { 
      orderId: response.data.id, 
      stripeSessionId: session.id 
    });
    
    const hasSubscription = lineItems.data.some(item => {
      const mapping = productMapping[item.price.id];
      return mapping && mapping.isSubscription;
    });
    
    if (hasSubscription && session.subscription) {
      await WooCommerce.put(`orders/${response.data.id}`, {
        meta_data: [
          ...response.data.meta_data,
          {
            key: 'stripe_subscription_id',
            value: session.subscription
          }
        ]
      });
      
      logger.info('Added Stripe subscription ID to WooCommerce order', {
        orderId: response.data.id,
        subscriptionId: session.subscription
      });
    }
    
    return response.data;
  } catch (error) {
    logger.error('Error creating WooCommerce order', { 
      sessionId: session.id, 
      error: error.message 
    });
    throw error;
  }
}

async function processSubscriptionRenewal(invoice, subscription, customerId) {
  try {
    const wooSubscription = await findWooSubscription(subscription.id, customerId);
    
    if (!wooSubscription) {
      logger.warn('No matching WooCommerce subscription found for renewal', {
        stripeSubscriptionId: subscription.id
      });
      return;
    }
    
    const renewalOrderData = {
      customer_id: customerId,
      payment_method: 'stripe',
      payment_method_title: 'Stripe',
      set_paid: true,
      status: 'processing',
      line_items: wooSubscription.line_items.map(item => ({
        product_id: item.product_id,
        quantity: item.quantity
      })),
      meta_data: [
        {
          key: 'stripe_invoice_id',
          value: invoice.id
        },
        {
          key: 'stripe_subscription_id',
          value: subscription.id
        },
        {
          key: 'is_renewal',
          value: 'true'
        }
      ]
    };
    
    const response = await WooCommerce.post('orders', renewalOrderData);
    
    logger.info('Created WooCommerce renewal order', {
      orderId: response.data.id,
      subscriptionId: wooSubscription.id,
      stripeInvoiceId: invoice.id
    });
    
    await updateWooSubscriptionStatus(wooSubscription.id, 'active');
    
    return response.data;
  } catch (error) {
    logger.error('Error processing subscription renewal', {
      invoiceId: invoice.id,
      subscriptionId: subscription.id,
      error: error.message
    });
    throw error;
  }
}

async function findWooSubscription(stripeSubscriptionId, customerId) {
  try {
    const subscriptionsResponse = await WooCommerce.get('subscriptions', {
      customer: customerId
    });
    
    if (subscriptionsResponse.data && subscriptionsResponse.data.length > 0) {
      const subscription = subscriptionsResponse.data.find(sub => {
        if (!sub.meta_data) return false;
        
        return sub.meta_data.some(meta => 
          meta.key === 'stripe_subscription_id' && 
          meta.value === stripeSubscriptionId
        );
      });
      
      if (subscription) {
        return subscription;
      }
      
      const activeSubscriptions = subscriptionsResponse.data
        .filter(sub => sub.status === 'active')
        .sort((a, b) => new Date(b.date_created) - new Date(a.date_created));
      
      if (activeSubscriptions.length > 0) {
        logger.warn('Using most recent active subscription as fallback', {
          stripeSubscriptionId,
          wooSubscriptionId: activeSubscriptions[0].id
        });
        return activeSubscriptions[0];
      }
    }
    
    logger.warn('No WooCommerce subscription found', { 
      stripeSubscriptionId, 
      customerId 
    });
    return null;
  } catch (error) {
    logger.error('Error finding WooCommerce subscription', {
      stripeSubscriptionId,
      customerId,
      error: error.message
    });
    throw error;
  }
}

async function updateWooSubscriptionStatus(subscriptionId, stripeStatus) {
  const statusMap = {
    'active': 'active',
    'past_due': 'on-hold',
    'unpaid': 'on-hold',
    'canceled': 'cancelled',
    'incomplete': 'pending',
    'incomplete_expired': 'cancelled',
    'trialing': 'active',
    'paused': 'on-hold'
  };
  
  const wooStatus = statusMap[stripeStatus] || 'on-hold';
  
  try {
    const response = await WooCommerce.put(`subscriptions/${subscriptionId}`, {
      status: wooStatus
    });
    
    logger.info('Updated WooCommerce subscription status', {
      subscriptionId,
      stripeStatus,
      wooStatus
    });
    
    return response.data;
  } catch (error) {
    logger.error('Error updating WooCommerce subscription status', {
      subscriptionId,
      stripeStatus,
      error: error.message
    });
    throw error;
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
});