const _ = require('lodash');

const AWS = require('aws-sdk');

const knexfileLoader = require('../knexfile');
const knex = require('knex');

const Helper = require('./Helper');

const { v4: uuidv4 } = require('uuid');

// ----------------------Dynamo dumps----------------------
const projectsJson = require('../downloaded_data/projects-production.json');
const experimentsJson = require('../downloaded_data/experiments-production.json');
const samplesJson = require('../downloaded_data/samples-production.json');
const userAccessJson = require('../downloaded_data/user-access-production.json');
const inviteAccessJson = require('../downloaded_data/invite-access-production.json');
const plotsJson = require('../downloaded_data/plots-tables-production.json');

// ----------------------Dynamo dumps END------------------

const environments = {
  DEVELOPMENT: 'development',
  STAGING: 'staging',
  PRODUCTION: 'production',
};

const activeEnvironment = environments.DEVELOPMENT;

const createSqlClient = async () => {
  const knexfile = await knexfileLoader(activeEnvironment);
  return knex.default(knexfile[activeEnvironment]);
}

const migrateProject = async (project, helper) => {
  const { projectUuid, projects: projectData } = project;
  const experimentId = projectData.experiments[0];
  const experimentData = _.find(experimentsJson, { 'experimentId': experimentId });

  const sampleData = _.find(samplesJson, { 'experimentId': experimentId });

  console.log(`Migrating ${projectUuid}, experiment ${experimentId}`);

  if (_.isNil(projectData) || _.isNil(experimentData) || _.isNil(sampleData)) {
    console.log(`>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>`);
    console.log(`>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>`);
    console.log(`[ MALFORMED ] - p: ${projectUuid}, e: ${experimentId} - One of these is nil:`);
    console.log(`projectData: ${projectData}, experimentData: ${experimentData}, sampleData: ${sampleData}`)
    console.log(`Finishing`);
    console.log(`>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>`);
    console.log(`>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>`);
    return;
  }

  await helper.sqlInsertExperiment(experimentId, projectData, experimentData);

  // Create experiment executions if we need to
  if (!_.isNil(experimentData.meta.gem2s)) {
    await helper.sqlInsertExperimentExecutionGem2s(experimentId, experimentData);
  }

  if (!_.isNil(experimentData.meta.pipeline)) {
    await helper.sqlInsertExperimentExecutionQC(experimentId, experimentData);
  }

  const samples = Object.values(sampleData.samples);
  if (samples.length === 0) {
    console.log(`No samples in the project ${projectUuid}, experiment ${experimentId}, finishing`)
    return;
  }

  // Migrate all samples
  await Promise.all(
    samples.map(async (sample) => {
      await helper.sqlInsertSample(experimentId, sample);

      const files = Object.entries(_.omit(sample.files, ['lastModified']));

      await Promise.all(
        files.map(async ([fileName, file]) => {
          const sampleFileUuid = uuidv4();

          await helper.sqlInsertSampleFile(sampleFileUuid, projectUuid, sample, fileName, file);

          await helper.sqlInsertSampleToSampleFileMap(sampleFileUuid, sample);
        })
      );
    })
  );

  // We can pick the metadata tracks from any sample, any of them has a reference to every metadata track
  const metadataTracks = Object.keys(samples[0].metadata);

  await Promise.all(
    metadataTracks.map(async (metadataTrack) => {
      await helper.sqlInsertMetadataTrack(metadataTrack, experimentId);

      await Promise.all(
        samples.map(async (sample) => {
          await helper.sqlInsertSampleInMetadataTrackMap(experimentId, metadataTrack, sample);
        })
      );
    })
  );
}

const migrateProjects = async (projects, helper) => {
  // const project = _.find(projects, {projectUuid: '669dea2a-e87d-4fa0-a072-626d60bd8c2e'});
  // await migrateProject(project, helper);

  await Promise.all(
    projects.map(async (p) => {
      try {
        await migrateProject(p, helper);
      } catch (e) {
        console.log(`----------------------------------------------------------------------------------------------------------------`);
        console.log(`----------------------------------------------------------------------------------------------------------------`);
        console.log(`---------------------------------- Error on project ${p.projectUuid} -------------------------`);
        console.log(e);
        console.log(`------------------------------- END Error on project ${p.projectUuid} ------------------------`);
        console.log(`----------------------------------------------------------------------------------------------------------------`);
        console.log(`----------------------------------------------------------------------------------------------------------------`);
      }
    })
  )
}

const migrateUserAccess = async (sqlClient, userAccess) => {
  userAccess.forEach(async (ua) => {
    const sqlUserAccess = {
      user_id: ua.userId,
      experiment_id: ua.experimentId,
      access_role: ua.role,
      updated_at: ua.createdDate
    };

    await sqlClient('user_access').insert(sqlUserAccess);
  });
}

const migrateInviteAccess = async (sqlClient, inviteAccess) => {
  inviteAccess.forEach(async (ia) => {
    const sqlAccess = {
      user_email: ia.userEmail,
      experiment_id: ia.experimentId,
      access_role: ia.role,
      updated_at: ia.createdDate

    };

    await sqlClient('invite_access').insert(sqlAccess);
  });
}

const migratePlots = async (sqlClient, plots) => {
  plots.forEach(async (p) => {
    const sql = {
      id: p.plotUuid,
      experiment_id: p.experimentId,
      config: p.config,
      s3_data_key: p.plotDataKey

    };

    await sqlClient('plot').insert(sql);
  });
}

const run = async () => {
  sqlClient = await createSqlClient();

  const helper = new Helper(sqlClient);

  await migrateProjects(projectsJson, helper);

  await Promise.all([
    migrateUserAccess(sqlClient, userAccessJson),
    migrateInviteAccess(sqlClient, inviteAccessJson),
    migratePlots(sqlClient, plotsJson)
  ]);
};

run()
  .then(() => {
    console.log('>>>>--------------------------------------------------------->>>>');
    console.log('                     finished');
    console.log('>>>>--------------------------------------------------------->>>>');
  }).catch((e) => console.log(e));