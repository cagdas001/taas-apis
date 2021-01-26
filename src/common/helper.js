/**
 * This file defines helper methods
 */

const querystring = require('querystring')
const AWS = require('aws-sdk')
const dateFNS = require('date-fns')
const config = require('config')
const HttpStatus = require('http-status-codes')
const _ = require('lodash')
const request = require('superagent')
const elasticsearch = require('@elastic/elasticsearch')
const errors = require('../common/errors')
const logger = require('./logger')
const models = require('../models')
const eventDispatcher = require('./eventDispatcher')
const busApi = require('@topcoder-platform/topcoder-bus-api-wrapper')

const localLogger = {
  debug: (message) => logger.debug({ component: 'helper', context: message.context, message: message.message })
}

AWS.config.region = config.esConfig.AWS_REGION

const m2mAuth = require('tc-core-library-js').auth.m2m

const m2m = m2mAuth(_.pick(config, ['AUTH0_URL', 'AUTH0_AUDIENCE', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET', 'AUTH0_PROXY_SERVER_URL']))

const m2mForUbahn = m2mAuth({
  AUTH0_AUDIENCE: config.AUTH0_AUDIENCE_UBAHN,
  ..._.pick(config, ['AUTH0_URL', 'TOKEN_CACHE_TIME', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET', 'AUTH0_PROXY_SERVER_URL'])
}
)

let busApiClient

/**
 * Get bus api client.
 *
 * @returns {Object} the bus api client
 */
function getBusApiClient () {
  if (busApiClient) {
    return busApiClient
  }
  busApiClient = busApi(_.pick(config, ['AUTH0_URL', 'AUTH0_AUDIENCE', 'TOKEN_CACHE_TIME', 'AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET', 'BUSAPI_URL', 'KAFKA_ERROR_TOPIC', 'AUTH0_PROXY_SERVER_URL'])
  )
  return busApiClient
}

// ES Client mapping
const esClients = {}

/**
 * Check if exists.
 *
 * @param {Array} source the array in which to search for the term
 * @param {Array | String} term the term to search
 */
function checkIfExists (source, term) {
  let terms

  if (!_.isArray(source)) {
    throw new Error('Source argument should be an array')
  }

  source = source.map(s => s.toLowerCase())

  if (_.isString(term)) {
    terms = term.toLowerCase().split(' ')
  } else if (_.isArray(term)) {
    terms = term.map(t => t.toLowerCase())
  } else {
    throw new Error('Term argument should be either a string or an array')
  }

  for (let i = 0; i < terms.length; i++) {
    if (source.includes(terms[i])) {
      return true
    }
  }

  return false
}

/**
 * Wrap async function to standard express function
 * @param {Function} fn the async function
 * @returns {Function} the wrapped function
 */
function wrapExpress (fn) {
  return function (req, res, next) {
    fn(req, res, next).catch(next)
  }
}

/**
 * Wrap all functions from object
 * @param obj the object (controller exports)
 * @returns {Object|Array} the wrapped object
 */
function autoWrapExpress (obj) {
  if (_.isArray(obj)) {
    return obj.map(autoWrapExpress)
  }
  if (_.isFunction(obj)) {
    if (obj.constructor.name === 'AsyncFunction') {
      return wrapExpress(obj)
    }
    return obj
  }
  _.each(obj, (value, key) => {
    obj[key] = autoWrapExpress(value)
  })
  return obj
}

/**
 * Get link for a given page.
 * @param {Object} req the HTTP request
 * @param {Number} page the page number
 * @returns {String} link for the page
 */
function getPageLink (req, page) {
  const q = _.assignIn({}, req.query, { page })
  return `${req.protocol}://${req.get('Host')}${req.baseUrl}${req.path}?${querystring.stringify(q)}`
}

/**
 * Set HTTP response headers from result.
 * @param {Object} req the HTTP request
 * @param {Object} res the HTTP response
 * @param {Object} result the operation result
 */
function setResHeaders (req, res, result) {
  if (result.fromDb) {
    return
  }
  const totalPages = Math.ceil(result.total / result.perPage)
  if (result.page > 1) {
    res.set('X-Prev-Page', result.page - 1)
  }
  if (result.page < totalPages) {
    res.set('X-Next-Page', result.page + 1)
  }
  res.set('X-Page', result.page)
  res.set('X-Per-Page', result.perPage)
  res.set('X-Total', result.total)
  res.set('X-Total-Pages', totalPages)
  // set Link header
  if (totalPages > 0) {
    let link = `<${getPageLink(req, 1)}>; rel="first", <${getPageLink(req, totalPages)}>; rel="last"`
    if (result.page > 1) {
      link += `, <${getPageLink(req, result.page - 1)}>; rel="prev"`
    }
    if (result.page < totalPages) {
      link += `, <${getPageLink(req, result.page + 1)}>; rel="next"`
    }
    res.set('Link', link)
  }
}

/**
 * Clear the object, remove all null or empty array field
 * @param {Object|Array} obj the given object
 */
function clearObject (obj) {
  if (_.isNull(obj)) {
    return undefined
  }
  if (_.isArray(obj)) {
    return _.map(obj, e => _.omitBy(e, _.isNull))
  } else {
    return _.omitBy(obj, (p) => { return _.isNull(p) || (_.isArray(p) && _.isEmpty(p)) })
  }
}

/**
 * Get ES Client
 * @return {Object} Elastic Host Client Instance
 */
function getESClient () {
  if (esClients.client) {
    return esClients.client
  }

  const host = config.esConfig.HOST
  const cloudId = config.esConfig.ELASTICCLOUD.id
  if (cloudId) {
    // Elastic Cloud configuration
    esClients.client = new elasticsearch.Client({
      cloud: {
        id: cloudId
      },
      auth: {
        username: config.esConfig.ELASTICCLOUD.username,
        password: config.esConfig.ELASTICCLOUD.password
      }
    })
  } else {
    esClients.client = new elasticsearch.Client({
      node: host
    })
  }
  return esClients.client
}

/*
 * Function to get M2M token
 * @returns {Promise}
 */
const getM2MToken = async () => {
  return await m2m.getMachineToken(config.AUTH0_CLIENT_ID, config.AUTH0_CLIENT_SECRET)
}

/*
 * Function to get M2M token for U-Bahn
 * @returns {Promise}
 */
const getM2MUbahnToken = async () => {
  return await m2mForUbahn.getMachineToken(config.AUTH0_CLIENT_ID, config.AUTH0_CLIENT_SECRET)
}

/**
 * Function to encode query string
 * @param {Object} queryObj the query object
 * @param {String} nesting the nesting string
 * @returns {String} query string
 */
function encodeQueryString (queryObj, nesting = '') {
  const pairs = Object.entries(queryObj).map(([key, val]) => {
    // Handle the nested, recursive case, where the value to encode is an object itself
    if (typeof val === 'object') {
      return encodeQueryString(val, nesting + `${key}.`)
    } else {
      // Handle base case, where the value to encode is simply a string.
      return [nesting + key, val].map(querystring.escape).join('=')
    }
  })
  return pairs.join('&')
}

/**
 * Function to get user ids
 * @param {Integer} userId  user id from jwt token
 * @returns {String} user id.
 */
async function getUserIds (userId) {
  const token = await getM2MUbahnToken()
  const q = {
    enrich: true,
    externalProfile: {
      organizationId: config.ORG_ID,
      externalId: userId
    }
  }
  const url = `${config.TC_API}/users?${encodeQueryString(q)}`
  const res = await request
    .get(url)
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json')
  localLogger.debug({ context: 'getUserIds', message: `response body: ${JSON.stringify(res.body)}` })
  return res.body
}

/**
 * Function to get user id
 * @param {Integer} userId  user id from jwt token
 * @returns {String} user id.
 */
async function getUserId (userId) {
  const ids = await getUserIds(userId)
  if (_.isEmpty(ids)) {
    throw new errors.NotFoundError(`userId: ${userId} "user" not found`)
  }
  return ids[0].id
}

/**
 * Send Kafka event message
 * @params {String} topic the topic name
 * @params {Object} payload the payload
 * @params {Object} options the extra options to control the function
 */
async function postEvent (topic, payload, options = {}) {
  logger.debug({ component: 'helper', context: 'postEvent', message: `Posting event to Kafka topic ${topic}, ${JSON.stringify(payload)}` })
  const client = getBusApiClient()
  const message = {
    topic,
    originator: config.KAFKA_MESSAGE_ORIGINATOR,
    timestamp: new Date().toISOString(),
    'mime-type': 'application/json',
    payload
  }
  await client.postEvent(message)
  await eventDispatcher.handleEvent(topic, { value: payload, options })
}

/**
 * Test if an error is document missing exception
 *
 * @param {Object} err the err
 * @returns {Boolean} the result
 */
function isDocumentMissingException (err) {
  if (err.statusCode === 404) {
    return true
  }
  return false
}

/**
 * Function to get projects
 * @param {Object} currentUser the user who perform this operation
 * @param {Object} criteria the search criteria
 * @returns the request result
 */
async function getProjects (currentUser, criteria = {}) {
  let token
  if (currentUser.hasManagePermission || currentUser.isMachine) {
    const m2mToken = await getM2MToken()
    token = `Bearer ${m2mToken}`
  } else {
    token = currentUser.jwtToken
  }
  const url = `${config.TC_API}/projects?type=talent-as-a-service`
  const res = await request
    .get(url)
    .query(criteria)
    .set('Authorization', token)
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json')
  localLogger.debug({ context: 'getProjects', message: `response body: ${JSON.stringify(res.body)}` })
  const result = _.map(res.body, item => {
    return _.pick(item, ['id', 'name'])
  })
  return {
    total: Number(_.get(res.headers, 'x-total')),
    page: Number(_.get(res.headers, 'x-page')),
    perPage: Number(_.get(res.headers, 'x-per-page')),
    result
  }
}

/**
 * Get topcoder user by id from /v3/users.
 *
 * @param {String} userId the legacy user id
 * @returns {Object} the user
 */
async function getTopcoderUserById (userId) {
  const token = await getM2MToken()
  const res = await request
    .get(config.TOPCODER_USERS_API)
    .query({ filter: `id=${userId}` })
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json')
  localLogger.debug({ context: 'getTopcoderUserById', message: `response body: ${JSON.stringify(res.body)}` })
  const user = _.get(res.body, 'result.content[0]')
  if (!user) {
    throw new errors.NotFoundError(`userId: ${userId} "user" not found from ${config.TOPCODER_USERS_API}`)
  }
  return user
}

/**
 * Function to get users
 * @param {String} userId the user id
 * @returns the request result
 */
async function getUserById (userId, enrich) {
  const token = await getM2MUbahnToken()
  const res = await request
    .get(`${config.TC_API}/users/${userId}` + (enrich ? '?enrich=true' : ''))
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json')
  localLogger.debug({ context: 'getUserById', message: `response body: ${JSON.stringify(res.body)}` })

  const user = _.pick(res.body, ['id', 'handle', 'firstName', 'lastName'])

  if (enrich) {
    user.skills = (res.body.skills || []).map((skillObj) => _.pick(skillObj.skill, ['id', 'name']))
  }

  return user
}

/**
 * Function to create user in ubahn
 * @param {Object} data the user data
 * @returns the request result
 */
async function createUbahnUser ({ handle, firstName, lastName }) {
  const token = await getM2MUbahnToken()
  const res = await request
    .post(`${config.TC_API}/users`)
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json')
    .send({ handle, firstName, lastName })
  localLogger.debug({ context: 'createUbahnUser', message: `response body: ${JSON.stringify(res.body)}` })
  return _.pick(res.body, ['id'])
}

/**
 * Function to create external profile for a ubahn user
 * @param {String} userId the user id(with uuid format)
 * @param {Object} data the profile data
 */
async function createUserExternalProfile (userId, { organizationId, externalId }) {
  const token = await getM2MUbahnToken()
  const res = await request
    .post(`${config.TC_API}/users/${userId}/externalProfiles`)
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json')
    .send({ organizationId, externalId: String(externalId) })
  localLogger.debug({ context: 'createUserExternalProfile', message: `response body: ${JSON.stringify(res.body)}` })
}

/**
 * Function to get members
 * @param {Array} handles the handle array
 * @returns the request result
 */
async function getMembers (handles) {
  const token = await getM2MToken()
  const handlesStr = _.map(handles, handle => {
    return '%22' + handle.toLowerCase() + '%22'
  }).join(',')
  const url = `${config.TC_API}/members?fields=userId,handleLower,photoURL&handlesLower=[${handlesStr}]`

  const res = await request
    .get(url)
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json')
  localLogger.debug({ context: 'getMembers', message: `response body: ${JSON.stringify(res.body)}` })
  return res.body
}

/**
 * Function to get project by id
 * @param {Object} currentUser the user who perform this operation
 * @param {Number} id project id
 * @returns the request result
 */
async function getProjectById (currentUser, id) {
  let token
  if (currentUser.hasManagePermission || currentUser.isMachine) {
    const m2mToken = await getM2MToken()
    token = `Bearer ${m2mToken}`
  } else {
    token = currentUser.jwtToken
  }
  const url = `${config.TC_API}/projects/${id}`
  try {
    const res = await request
      .get(url)
      .set('Authorization', token)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json')
    localLogger.debug({ context: 'getProjectById', message: `response body: ${JSON.stringify(res.body)}` })
    return _.pick(res.body, ['id', 'name'])
  } catch (err) {
    if (err.status === HttpStatus.FORBIDDEN) {
      throw new errors.ForbiddenError(`You are not allowed to access the project with id ${id}`)
    }
    if (err.status === HttpStatus.NOT_FOUND) {
      throw new errors.NotFoundError(`id: ${id} project not found`)
    }
    throw err
  }
}

/**
 * Function to search skills from v5/skills
 * - only returns skills from Topcoder Skills Provider defined by `TOPCODER_SKILL_PROVIDER_ID`
 *
 * @param {Object} criteria the search criteria
 * @returns the request result
 */
async function getTopcoderSkills (criteria) {
  const token = await getM2MUbahnToken()
  try {
    const res = await request
      .get(`${config.TC_API}/skills`)
      .query({
        skillProviderId: config.TOPCODER_SKILL_PROVIDER_ID,
        ...criteria
      })
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json')
    localLogger.debug({ context: 'getTopcoderSkills', message: `response body: ${JSON.stringify(res.body)}` })
    return {
      total: Number(_.get(res.headers, 'x-total')),
      page: Number(_.get(res.headers, 'x-page')),
      perPage: Number(_.get(res.headers, 'x-per-page')),
      result: res.body
    }
  } catch (err) {
    if (err.status === HttpStatus.BAD_REQUEST) {
      throw new errors.BadRequestError(err.response.body.message)
    }
    throw err
  }
}

/**
 * Function to get skill by id
 * @param {String} skillId the skill Id
 * @returns the request result
 */
async function getSkillById (skillId) {
  const token = await getM2MUbahnToken()
  const res = await request
    .get(`${config.TC_API}/skills/${skillId}`)
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json')
  localLogger.debug({ context: 'getSkillById', message: `response body: ${JSON.stringify(res.body)}` })
  return _.pick(res.body, ['id', 'name'])
}

/**
 * Encapsulate the getUserId function.
 * Make sure a user exists in ubahn(/v5/users) and return the id of the user.
 *
 * In the case the user does not exist in /v5/users but can be found in /v3/users
 * Fetch the user info from /v3/users and create a new user in /v5/users.
 *
 * @params {Object} currentUser the user who perform this operation
 * @returns {String} the ubahn user id
 */
async function ensureUbahnUserId (currentUser) {
  try {
    return await getUserId(currentUser.userId)
  } catch (err) {
    if (!(err instanceof errors.NotFoundError)) {
      throw err
    }
    const topcoderUser = await getTopcoderUserById(currentUser.userId)
    const user = await createUbahnUser(_.pick(topcoderUser, ['handle', 'firstName', 'lastName']))
    await createUserExternalProfile(user.id, { organizationId: config.ORG_ID, externalId: currentUser.userId })
    return user.id
  }
}

/**
 * Ensure job with specific id exists.
 *
 * @param {String} jobId the job id
 * @returns {Object} the job data
 */
async function ensureJobById (jobId) {
  return models.Job.findById(jobId)
}

/**
 * Ensure user with specific id exists.
 *
 * @param {String} jobId the user id
 * @returns {Object} the user data
 */
async function ensureUserById (userId) {
  const token = await getM2MUbahnToken()
  try {
    const res = await request
      .get(`${config.TC_API}/users/${userId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json')
    localLogger.debug({ context: 'ensureUserById', message: `response body: ${JSON.stringify(res.body)}` })
    return res.body
  } catch (err) {
    if (err.status === HttpStatus.NOT_FOUND) {
      throw new errors.NotFoundError(`id: ${userId} "user" not found`)
    }
    throw err
  }
}

/**
 * Generate M2M auth user.
 *
 * @returns {Object} the M2M auth user
 */
function getAuditM2Muser () {
  return { isMachine: true, userId: config.m2m.M2M_AUDIT_USER_ID, handle: config.m2m.M2M_AUDIT_HANDLE }
}

/**
 * Function to check whether a user is a member of a project
 * by first retrieving the project detail via /v5/projects/:projectId and
 * then checking whether the user was included in the `members` property of the project detail object.
 *
 * @param {Object} userId the id of the user
 * @param {Number} projectId project id
 * @returns the result
 */
async function checkIsMemberOfProject (userId, projectId) {
  const m2mToken = await getM2MToken()
  const res = await request
    .get(`${config.TC_API}/projects/${projectId}`)
    .set('Authorization', `Bearer ${m2mToken}`)
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json')
  const memberIdList = _.map(res.body.members, 'userId')
  localLogger.debug({ context: 'checkIsMemberOfProject', message: `the members of project ${projectId}: ${memberIdList}` })
  if (!memberIdList.includes(userId)) {
    throw new errors.UnauthorizedError(`userId: ${userId} the user is not a member of project ${projectId}`)
  }
}

/**
 * Do calculation between startDate, endDate and duration.
 * Logic of the calculation is:
 *  - start + duration => calculate end
 *  - end + duration => calculate start
 *  - start + end => calculate duration
 *  - start + end + duration => check if (end - start = duration)
 *
 * @param {Object} startDate the start date - endDate the end date - duration the duration
 * @returns {Object} the object containing startDate, endDate and duration
 */
function calculateDuration ({ startDate, endDate, duration }) {
  localLogger.debug({ context: 'calculateDuration', message: `startDate: ${startDate}, endDate: ${endDate}, duration: ${duration}` })
  if (startDate && !endDate && duration) {
    return {
      startDate,
      endDate: dateFNS.addWeeks(new Date(startDate), duration),
      duration
    }
  }
  if (!startDate && endDate && duration) {
    return {
      startDate: dateFNS.subWeeks(new Date(endDate), duration),
      endDate,
      duration
    }
  }
  if (startDate && endDate) {
    const diffDate = new Date(new Date(endDate).getTime() - new Date(startDate).getTime())
    const actualDuration = diffDate.getTime() / (7 * 24 * 60 * 60 * 1000) // divided by one week
    if (!Number.isInteger(actualDuration) || actualDuration < 1) {
      throw new errors.BadRequestError('end date must be one or multiple weeks ahead of start date')
    }
    if (duration && actualDuration !== duration) {
      throw new errors.BadRequestError('duration not match with the actual duration bwteen startDate and endDate')
    }
    return { startDate, endDate, duration: actualDuration }
  }
  return {}
}

/**
 * Update original duration object(i.e. the startDate, endDate and duration fields) from a new one.
 * There are two cases to be considered:
 *
 *  - When there is only one of the startDate, endDate and duration fields is to be updated,
 *    then try to re-calculate the duration object with the field.
 *
 *  - When there are more than one of the startDate, endDate and duration fields are to be updated,
 *    then drop the original duration object and use the new one calculated from the fields.
 *
 * @param {Object} original the original duration object
 * @param {Object} data the new duration object
 * @returns {Object} the updated duration object
 */
function updateDuration (original, data) {
  const modifiedFields = _.reduce(['startDate', 'endDate', 'duration'], (result, field) => {
    if (data[field] && !_.isEqual(data[field], original[field])) {
      result.push(field)
    }
    return result
  }, [])
  if (!modifiedFields.length) {
    return {}
  }
  localLogger.debug({ context: 'updateDuration', message: `modified fields: ${modifiedFields}` })
  const fieldsCount = Object.keys(data).length
  if (fieldsCount === 1) {
    return calculateDuration(_.reduce(['startDate', 'endDate', 'duration'], (result, field) => {
      if (modifiedFields[0] === field) {
        result[field] = data[field]
        return result
      }
      result[field] = original[field]
      return result
    }, {}))
  }
  if (fieldsCount > 1) {
    return calculateDuration(data)
  }
}

module.exports = {
  checkIfExists,
  autoWrapExpress,
  setResHeaders,
  clearObject,
  getESClient,
  getUserId: async (userId) => {
    // check m2m user id
    if (userId === config.m2m.M2M_AUDIT_USER_ID) {
      return config.m2m.M2M_AUDIT_USER_ID
    }
    return ensureUbahnUserId({ userId })
  },
  getM2MToken,
  getM2MUbahnToken,
  postEvent,
  getBusApiClient,
  isDocumentMissingException,
  getProjects,
  getUserById,
  getMembers,
  getProjectById,
  getTopcoderSkills,
  getSkillById,
  ensureJobById,
  ensureUserById,
  getAuditM2Muser,
  checkIsMemberOfProject,
  calculateDuration,
  updateDuration
}
