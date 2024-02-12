using {
    managed,
    cuid
} from '@sap/cds/common';

using {API_PROJECT_V3 as api} from '../srv/external/API_PROJECT_V3';


namespace autoExpand;

entity Tags : cuid {
    type    : Association to one Types @mandatory;
    project : Association to one Projects;
}

entity Types : cuid {
    tags : Association to many Tags
               on tags.type = $self;
}

entity Customers : cuid {
    key IDTWO             : UUID;
        customersprojects : Association to many CustomersProjects
                                on customersprojects.customer = $self
}

entity CustomersProjects {
    key customer : Composition of one Customers;
    key project  : Composition of one Projects;
}

@readonly
entity Projects    as
    projection on api.Project {
        key ProjectInternalID  as ID,
        key ProjectExternalID  as externalID,
            ProjectDescription as Description,
            CompanyCode,
            Tags              : Association to many Tags on $self = Tags.project,
            customersprojects : Association to many CustomersProjects on customersprojects.project = $self
    }

@readonly
entity WBSElements as
    projection on api.WBSElement {
        key WBSElementInternalID as ID,
            ProjectInternalID,
            WBSDescription
    };
