using {
    managed,
    cuid
} from '@sap/cds/common';

using {API_PROJECT_V3 as api} from '../srv/external/API_PROJECT_V3';


namespace autoExpand;

entity Tags : cuid, managed {
    type    : Association to one Types @mandatory;
    project : Association to one Projects;
}

entity Types : cuid, managed {
    tags : Association to many Tags
               on tags.type = $self;
}

@readonly
entity Projects    as
    projection on api.Project {
        key ProjectInternalID  as ID,
            ProjectDescription as Description,
            CompanyCode,
            ProfitCenter,
            PlannedStartDate,
            PlannedEndDate,
            ResponsiblePerson,
            ResponsiblePersonName,
            ApplicantCode,
            ApplicantName,
            ForecastedStartDate,
            ForecastedEndDate,
            Plant,
            Currency,
            BudgetProfile,
            PlanningProfile,
            InvestmentProfile,
            Tags : Association to many Tags on Tags.project = $self
    }

@readonly
entity WBSElements as
    projection on api.WBSElement {
        key WBSElementInternalID as ID,
            ProjectInternalID,
            WBSDescription
    };
