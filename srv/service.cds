using {autoExpand} from '../db/schema';

service Service {
    entity Tags        as projection on autoExpand.Tags

    @readonly
    entity Types       as projection on autoExpand.Types

    entity Customer as projection on autoExpand.Customers

    entity CustomersProjects as projection on autoExpand.CustomersProjects;

    @readonly
    entity Projects as projection on autoExpand.Projects

    @readonly
    entity WBSElements as projection on autoExpand.WBSElements;
}
