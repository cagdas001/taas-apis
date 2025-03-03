/*
 * Handle events for WorkPeriodPayment.
 */

const _ = require('lodash')
const config = require('config')
const models = require('../models')
const logger = require('../common/logger')
const helper = require('../common/helper')
const { ActiveWorkPeriodPaymentStatuses } = require('../../app-constants')
const WorkPeriod = models.WorkPeriod

/**
 * When a WorkPeriodPayment is updated or created, the workPeriod related to
 * that WorkPeriodPayment should be updated also.
 * @param {object} payload the event payload
 * @returns {undefined}
 */
async function updateWorkPeriod (payload) {
  const workPeriodPayment = payload.value
  // find related workPeriod to evaluate the changes
  const workPeriodModel = await WorkPeriod.findById(workPeriodPayment.workPeriodId, { withPayments: true })
  const workPeriod = workPeriodModel.toJSON()
  const data = {}
  data.daysPaid = 0
  data.paymentTotal = 0
  _.each(workPeriod.payments, payment => {
    if (_.includes(ActiveWorkPeriodPaymentStatuses, payment.status)) {
      data.daysPaid += payment.days
      data.paymentTotal += payment.amount
    }
  })
  data.paymentStatus = helper.calculateWorkPeriodPaymentStatus(_.assign({}, workPeriod, data))
  if (workPeriod.daysPaid === data.daysPaid && workPeriod.paymentTotal === data.paymentTotal && workPeriod.paymentStatus === data.paymentStatus) {
    logger.debug({
      component: 'WorkPeriodPaymentEventHandler',
      context: 'updateWorkPeriod',
      message: `id: ${workPeriod.id} WorkPeriod has no change - ignored`
    })
    return
  }
  const updated = await workPeriodModel.update(data)
  await helper.postEvent(config.TAAS_WORK_PERIOD_UPDATE_TOPIC, _.omit(updated.toJSON(), 'payments'), { oldValue: workPeriod, key: `resourceBooking.id:${workPeriod.resourceBookingId}` })
  logger.debug({
    component: 'WorkPeriodPaymentEventHandler',
    context: 'updateWorkPeriod',
    message: `id: ${workPeriod.id} WorkPeriod updated`
  })
}

/**
 * Process work period payment create event.
 *
 * @param {Object} payload the event payload
 * @returns {undefined}
 */
async function processCreate (payload) {
  await updateWorkPeriod(payload)
}

/**
 * Process work period payment update event.
 *
 * @param {Object} payload the event payload
 * @returns {undefined}
 */
async function processUpdate (payload) {
  await updateWorkPeriod(payload)
}

module.exports = {
  processCreate,
  processUpdate
}
