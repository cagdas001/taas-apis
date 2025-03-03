const Kafka = require('no-kafka')
const fs = require('fs')
const config = require('config')
const moment = require('moment')
const handlebars = require('handlebars')
const logger = require('../../src/common/logger')
const { Interview, JobCandidate, ResourceBooking } = require('../../src/models')
const { Interviews } = require('../../app-constants')

const consumer = new Kafka.GroupConsumer({ connectionString: process.env.KAFKA_URL, groupId: 'test-render-email' })

const localLogger = {
  debug: message => logger.debug({ component: 'render email content', context: 'test', message }),
  info: message => logger.info({ component: 'render email content', context: 'test', message })
}

const template = handlebars.compile(fs.readFileSync('./data/notifications-email-template.html', 'utf8'))

/**
 * Reset notification records
 */
async function resetNotificationRecords () {
  // reset coming up interview records
  localLogger.info('reset coming up interview records')
  const interview = await Interview.findById('976d23a9-5710-453f-99d9-f57a588bb610')
  const startTimestamp = moment().add(moment.duration(config.INTERVIEW_COMING_UP_REMIND_TIME[0])).add(config.INTERVIEW_COMING_UP_MATCH_WINDOW).toDate()
  await interview.update({ startTimestamp, duration: 30, status: Interviews.Status.Scheduled, guestNames: ['test1', 'test2'], hostName: 'hostName' })

  // reset completed interview records
  localLogger.info('reset completed interview records')
  const pastTime = moment.duration(config.INTERVIEW_COMPLETED_PAST_TIME)
  const endTimestamp = moment().subtract(pastTime).add(config.INTERVIEW_COMPLETED_MATCH_WINDOW).toDate()
  const completedInterview = await Interview.findById('9efd72c3-1dc7-4ce2-9869-8cca81d0adeb')
  const duration = 30
  const completedStartTimestamp = moment().subtract(pastTime).subtract(30, 'm').toDate()
  await completedInterview.update({ startTimestamp: completedStartTimestamp, duration, endTimestamp, status: Interviews.Status.Scheduled, guestNames: ['guest1', 'guest2'], hostName: 'hostName' })

  // reset post interview candidate action reminder records
  localLogger.info('reset post interview candidate action reminder records')
  const jobCandidate = await JobCandidate.findById('881a19de-2b0c-4bb9-b36a-4cb5e223bdb5')
  await jobCandidate.update({ status: 'interview' })
  const c2Interview = await Interview.findById('077aa2ca-5b60-4ad9-a965-1b37e08a5046')
  await c2Interview.update({ startTimestamp: completedStartTimestamp, duration, endTimestamp, guestNames: ['guest1', 'guest2'], hostName: 'hostName' })

  // reset upcoming resource booking expiration records
  localLogger.info('reset upcoming resource booking expiration records')
  const resourceBooking = await ResourceBooking.findById('62c3f0c9-2bf0-4f24-8647-2c802a39cbcb')
  const testEnd = moment().add(moment.duration(config.RESOURCE_BOOKING_EXPIRY_TIME)).toDate()
  await resourceBooking.update({ endDate: testEnd })
}

/**
 * Init consumer.
 */
async function initConsumer () {
  await consumer
    .init([{
      subscriptions: [config.NOTIFICATIONS_CREATE_TOPIC],
      handler: async (messageSet, topic, partition) => {
        localLogger.debug(`Consumer handler. Topic: ${topic}, partition: ${partition}, message set length: ${messageSet.length}`)
        for (const m of messageSet) {
          const message = JSON.parse(m.message.value.toString('utf8'))
          if (!fs.existsSync('out')) {
            fs.mkdirSync('out')
          }
          if (message.payload.notifications) {
            message.payload.notifications.forEach((notification) => {
              const email = template(notification.details.data)
              fs.writeFileSync(`./out/${notification.details.data.subject}-${Date.now()}.html`, email)
            })
          }
        }
      }
    }])
    .then(() => {
      localLogger.info('Initialized.......')
      localLogger.info([config.NOTIFICATIONS_CREATE_TOPIC])
      localLogger.info('Kick Start.......')
    }).catch(err => {
      logger.logFullError(err, { component: 'app' })
    })
}

/**
 * Main function
 */
async function main () {
  await resetNotificationRecords()
  await initConsumer()
}

main()
