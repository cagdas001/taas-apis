const config = require('config')
const moment = require('moment')

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction()
    try {
      await queryInterface.addColumn({ tableName: 'resource_bookings', schema: config.DB_SCHEMA_NAME }, 'send_weekly_survey',
        { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        { transaction })
      await queryInterface.addColumn({ tableName: 'work_periods', schema: config.DB_SCHEMA_NAME }, 'sent_survey',
        { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        { transaction })
      await queryInterface.addColumn({ tableName: 'work_periods', schema: config.DB_SCHEMA_NAME }, 'sent_survey_error',
        {
          type: Sequelize.JSONB({
            errorCode: {
              field: 'error_code',
              type: Sequelize.INTEGER,
            },
            errorMessage: {
              field: 'error_message',
              type: Sequelize.STRING(255)
            },
          }), allowNull: true }, { transaction })
      await queryInterface.sequelize.query(`UPDATE ${config.DB_SCHEMA_NAME}.work_periods SET sent_survey = true where payment_status = 'completed' and end_date <= '${moment().subtract(7, 'days').format('YYYY-MM-DD')}'`,
        { transaction })
      await transaction.commit()
    } catch (err) {
      await transaction.rollback()
      throw err
    }
  },
  down: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction()
    try {
      await queryInterface.removeColumn({ tableName: 'resource_bookings', schema: config.DB_SCHEMA_NAME }, 'send_weekly_survey', { transaction })
      await queryInterface.removeColumn({ tableName: 'work_periods', schema: config.DB_SCHEMA_NAME }, 'sent_survey', { transaction })
      await queryInterface.removeColumn({ tableName: 'work_periods', schema: config.DB_SCHEMA_NAME }, 'sent_survey_error', { transaction } )
      await transaction.commit()
    } catch (err) {
      await transaction.rollback()
      throw err
    }
  },
}
